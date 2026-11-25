import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { costOf } from '../../src/core/cost.ts'
import type { Id, Product, Run } from '../../src/core/types.ts'
import { JobRunner, NUDGE_TEXT, RETRY_DELAY_MS, isTransient, type RuntimeSettings, type SessionPlan } from '../../src/host/jobs/runner.ts'
import { researchTools } from '../../src/host/tools.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, completed, failure, flush, gate, instantClock, usage } from '../fixtures/fake-driver.ts'

const TODAY = '2026-11-25'
const PROMPT = '找 Cursor 近一天的新动态'

let dir: string
let db: Db
let repo: Repo
let time: ReturnType<typeof instantClock>
let driver: FakeDriver
let settings: RuntimeSettings
let runner: JobRunner
let log: ReturnType<typeof vi.fn<(message: string) => void>>
let cursor: Product
let windsurf: Product
let seedRun: Run

const productSpec = (name: string, company: string, over: Partial<Product> = {}) =>
  ({ name, company, region: 'overseas' as const, form: 'IDE', iconPath: null, officialDomains: [], status: 'tracking' as const, dailyBudgetYuan: null, ...over })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-runner-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  time = instantClock(new Date(2026, 10, 25, 8, 0, 0)) // local wall-clock, so TODAY is the same day in every time zone
  repo = new Repo(db, () => time.clock.now())
  driver = new FakeDriver()
  settings = { maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, prices: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }, model: null }
  log = vi.fn<(message: string) => void>()
  runner = new JobRunner({ repo, driver, clock: time.clock, settings: () => settings, log })
  cursor = repo.upsertProduct({ id: 'p1', ...productSpec('Cursor', 'Anysphere') })
  windsurf = repo.upsertProduct({ id: 'p2', ...productSpec('Windsurf', 'Codeium') })
  // Spending of an earlier run today, on another product.
  seedRun = repo.createRun({ kind: 'recommend', date: TODAY, trackId: null, productId: null })
  repo.updateRun(seedRun.id, { status: 'done' })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A daily session about one product, with the real daily tools. */
const daily = (productId: Id) => (runId: Id): SessionPlan => ({
  title: `前哨 · ${productId} 日更`,
  prompt: PROMPT,
  tools: onDone => researchTools('daily', { repo, runId, trackId: null, productId, now: () => time.clock.now(), icons: { fetch: async () => null }, onDone }),
})
const build = daily('p1')
/** Every round calls `outpost_done` and ends normally. */
const finishes = (used: Parameters<typeof completed>[0] = {}) => async (r: { done(): Promise<unknown> }) => { await r.done(); return completed(used) }

describe('budget', () => {
  it('skips with a reason when the daily budget is spent', async () => {
    repo.updateRun(seedRun.id, { costYuan: 20 })
    const run = await runner.session('daily', { productId: 'p1' }, build)
    expect(run).toMatchObject({ status: 'skipped', error: '今日总预算已用完', kind: 'daily', productId: 'p1', date: TODAY, sessionId: null })
    expect(repo.getRun(run.id)).toMatchObject({ status: 'skipped', error: '今日总预算已用完' })
    expect(driver.runs).toHaveLength(0)
  })

  it('skips a product whose own budget is spent, and still runs the others', async () => {
    repo.upsertProduct({ id: 'p1', ...productSpec('Cursor', 'Anysphere', { dailyBudgetYuan: 1 }) })
    const earlier = repo.createRun({ kind: 'daily', date: TODAY, trackId: null, productId: 'p1' })
    repo.updateRun(earlier.id, { status: 'done', costYuan: 1 })
    driver.script['outpost-daily-'] = finishes()

    const capped = await runner.session('daily', { productId: 'p1' }, build)
    const other = await runner.session('daily', { productId: 'p2' }, daily('p2'))

    expect(capped).toMatchObject({ status: 'skipped', error: '该产品今日预算已用完' })
    expect(other).toMatchObject({ status: 'done', error: null })
    expect(driver.runs.map(s => s.title)).toEqual(['前哨 · p2 日更'])
  })

  it('skips queued sessions once the budget runs out mid-way', async () => {
    settings.maxParallel = 1
    settings.dailyBudgetYuan = 5
    driver.script['outpost-daily-'] = finishes({ outputTokens: 1_000_000 }) // 8 yuan

    const [first, second] = await Promise.all([runner.session('daily', { productId: 'p1' }, build), runner.session('daily', { productId: 'p2' }, daily('p2'))])

    expect(first).toMatchObject({ status: 'done', costYuan: 8 })
    expect(second).toMatchObject({ status: 'skipped', error: '今日总预算已用完', sessionId: null })
    expect(driver.runs).toHaveLength(1)
  })

  it('counts a run in the day it is given, not the day it runs', async () => {
    repo.updateRun(seedRun.id, { costYuan: 20 }) // today is spent; yesterday is not
    driver.script['outpost-daily-'] = finishes()
    const run = await runner.session('daily', { productId: 'p1', date: '2026-11-24' }, build)
    expect(run).toMatchObject({ status: 'done', date: '2026-11-24' })
  })

  it('refuses to run with a daily budget that is not a number', async () => {
    settings.dailyBudgetYuan = Number.NaN
    const run = await runner.session('daily', { productId: 'p1' }, build)
    expect(run).toMatchObject({ status: 'skipped', error: '每日预算设置无效' })
    expect(driver.runs).toHaveLength(0)
  })
})

describe('sessions', () => {
  it('never runs more than maxParallel sessions at once', async () => {
    settings.maxParallel = 2
    let active = 0
    let peak = 0
    const held: ReturnType<typeof gate>[] = []
    driver.script['outpost-daily-'] = async r => {
      active++
      peak = Math.max(peak, active)
      const g = gate()
      held.push(g)
      await g.promise
      active--
      await r.done()
      return completed()
    }

    const started = Array.from({ length: 5 }, () => runner.start('daily', { productId: 'p1' }, build))
    await flush()
    expect(active).toBe(2)
    expect(started.map(s => repo.getRun(s.run.id)!.status)).toEqual(['running', 'running', 'queued', 'queued', 'queued'])

    for (let released = 0; released < 5; released++) {
      await vi.waitFor(() => expect(held.length).toBeGreaterThan(released))
      held[released]!.open()
      await flush()
      expect(active).toBeLessThanOrEqual(2)
    }
    const runs = await Promise.all(started.map(s => s.finished))

    expect(runs.map(r => r.status)).toEqual(['done', 'done', 'done', 'done', 'done'])
    expect(peak).toBe(2)
    expect(driver.runs).toHaveLength(5)
  })

  it('names the session after its kind and run, and passes title, prompt, tools and model', async () => {
    settings.model = { provider: 'deepseek', model: 'deepseek-flash' }
    driver.script['outpost-daily-'] = finishes()
    const run = await runner.session('daily', { productId: 'p1' }, build)

    expect(run.sessionId).toBe(`outpost-daily-${run.id.slice(0, 8)}`)
    expect(driver.runs[0]).toMatchObject({ sessionId: run.sessionId, title: '前哨 · p1 日更', prompt: PROMPT, model: { provider: 'deepseek', model: 'deepseek-flash' } })
    expect(driver.runs[0]!.tools.map(t => t.name)).toContain('outpost_done')
    expect(run).toMatchObject({ status: 'done', error: null })
    expect(run.startedAt).not.toBeNull()
    expect(run.endedAt).not.toBeNull()
  })

  it('retries a transient error 3 times then fails', async () => {
    driver.script['outpost-daily-'] = () => failure('429 Too Many Requests: rate limit reached', { inputTokens: 1000 })
    const run = await runner.session('daily', { productId: 'p1' }, build)

    expect(driver.runs).toHaveLength(4) // the first try and 3 retries
    expect(driver.runs.every(s => s.sessionId === run.sessionId && s.prompt === PROMPT)).toBe(true)
    expect(time.waits).toEqual([RETRY_DELAY_MS, RETRY_DELAY_MS, RETRY_DELAY_MS])
    expect(RETRY_DELAY_MS).toBe(15_000)
    expect(driver.nudges).toHaveLength(0)
    expect(run.status).toBe('failed')
    expect(run.error).toContain('429 Too Many Requests')
    expect(run.usage.inputTokens).toBe(4000) // failed tries cost money too
  })

  it('goes on after a transient error clears', async () => {
    driver.script['outpost-daily-'] = async r => {
      if (r.number < 3) return failure('fetch failed: ECONNRESET')
      await r.done()
      return completed()
    }
    const run = await runner.session('daily', { productId: 'p1' }, build)
    expect(driver.runs).toHaveLength(3)
    expect(run).toMatchObject({ status: 'done', error: null })
  })

  it('fails at once on an error that is not transient, a time-out or a block', async () => {
    driver.script['outpost-daily-'] = () => failure('Invalid API key')
    const broken = await runner.session('daily', { productId: 'p1' }, build)
    expect(broken).toMatchObject({ status: 'failed', error: 'Invalid API key' })

    driver.script['outpost-daily-'] = () => ({ reason: 'timeout', usage: usage() })
    const slow = await runner.session('daily', { productId: 'p1' }, build)
    expect(slow.status).toBe('failed')
    expect(slow.error).toContain('30 分钟')

    driver.script['outpost-daily-'] = () => ({ reason: 'blocked', usage: usage() })
    const blocked = await runner.session('daily', { productId: 'p1' }, build)
    expect(blocked.status).toBe('failed')

    expect(driver.runs).toHaveLength(3)
    expect(driver.nudges).toHaveLength(0)
    expect(time.waits).toEqual([])
  })

  it('fails the run when the session cannot be opened at all', async () => {
    driver.run = async () => { throw new Error('dsh-outpost: DSH created session "x" instead of "y"') }
    const run = await runner.session('daily', { productId: 'p1' }, build)
    expect(run).toMatchObject({ status: 'failed', error: 'dsh-outpost: DSH created session "x" instead of "y"' })
  })

  it('nudges once when the agent ends without outpost_done', async () => {
    driver.script['outpost-daily-'] = async r => {
      if (r.kind === 'nudge') await r.done('补交完毕')
      return completed()
    }
    const run = await runner.session('daily', { productId: 'p1' }, build)
    expect(driver.nudges).toEqual([{ sessionId: run.sessionId, text: NUDGE_TEXT }])
    expect(NUDGE_TEXT).toBe('请继续完成任务；全部提交后调用 outpost_done。')
    expect(run).toMatchObject({ status: 'done', error: null })

    // An agent that still does not say it is done is nudged only once; what it handed in stands.
    driver.script['outpost-daily-'] = () => completed()
    const stubborn = await runner.session('daily', { productId: 'p1' }, build)
    expect(driver.nudges.filter(n => n.sessionId === stubborn.sessionId)).toHaveLength(1)
    expect(stubborn.status).toBe('done')
    expect(stubborn.error).toContain('outpost_done')

    // An agent that said it is done in its first round is not nudged.
    driver.script['outpost-daily-'] = finishes()
    const prompt = await runner.session('daily', { productId: 'p1' }, build)
    expect(driver.nudges.filter(n => n.sessionId === prompt.sessionId)).toHaveLength(0)
  })

  it('records cost from usage and prices', async () => {
    driver.script['outpost-daily-'] = async r => {
      if (r.kind === 'run') return completed({ inputTokens: 1_000_000, outputTokens: 250_000, cacheReadTokens: 3_000_000 })
      await r.done()
      return completed({ inputTokens: 100_000, outputTokens: 50_000 })
    }
    const run = await runner.session('daily', { productId: 'p1' }, build)

    const total = { inputTokens: 1_100_000, outputTokens: 300_000, cacheReadTokens: 3_000_000 }
    expect(run.usage).toEqual(total)
    expect(run.costYuan).toBe(costOf(total, settings.prices))
    expect(run.costYuan).toBe(4.72) // 1.1 × 2 + 0.3 × 8 + 3 × 0.04
    expect(repo.spentOn(TODAY, 'p1')).toBe(4.72)
  })

  it('fails sessions in flight and in the queue when it stops', async () => {
    settings.maxParallel = 1
    driver.script['outpost-daily-'] = r => new Promise(resolve => {
      r.signal.addEventListener('abort', () => resolve({ reason: 'timeout', usage: usage({ outputTokens: 10 }) }), { once: true })
    })
    const first = runner.start('daily', { productId: 'p1' }, build)
    const second = runner.start('daily', { productId: 'p2' }, daily('p2'))
    await flush()
    expect(driver.runs).toHaveLength(1)

    await runner.stop()

    expect(await first.finished).toMatchObject({ status: 'failed', error: '前哨已停止' })
    expect(await second.finished).toMatchObject({ status: 'failed', error: '前哨已停止' })
    expect(driver.runs).toHaveLength(1)
  })
})

describe('isTransient', () => {
  it('knows network, rate-limit and 5xx failures from the rest', () => {
    const error = (text: string) => isTransient({ reason: 'error', usage: usage(), error: text })
    for (const text of ['fetch failed', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443', 'getaddrinfo EAI_AGAIN api.deepseek.com', 'UND_ERR_SOCKET', 'socket hang up',
      '429 Too Many Requests', 'Rate limit exceeded', 'HTTP 503 Service Unavailable', '502 Bad Gateway', 'The server is overloaded'])
      expect(error(text), text).toBe(true)
    for (const text of ['Invalid API key', '400 Bad Request: messages too long', 'tool schema rejected', ''])
      expect(error(text), text).toBe(false)
    expect(isTransient({ reason: 'timeout', usage: usage(), error: 'ETIMEDOUT' })).toBe(false)
  })
})

describe('archiveOld', () => {
  const ended = (sessionId: string | null, endedAt: string | null, kind: Run['kind'] = 'daily') => {
    const run = repo.createRun({ kind, date: '2026-11-10', trackId: null, productId: 'p1' })
    repo.updateRun(run.id, { sessionId, endedAt, status: endedAt ? 'done' : 'running' })
    return run
  }

  it('archives sessions that ended more than 7 days ago, once', async () => {
    const now = new Date(2026, 10, 25, 8, 0, 0)
    ended('outpost-daily-old', new Date(2026, 10, 18, 7, 0, 0).toISOString())
    ended('outpost-daily-gone', new Date(2026, 10, 17, 7, 0, 0).toISOString())
    ended('outpost-daily-recent', new Date(2026, 10, 18, 9, 0, 0).toISOString())
    ended('outpost-daily-running', null)
    ended(null, new Date(2026, 10, 10, 7, 0, 0).toISOString()) // skipped: never had a session
    ended('outpost-followup-chat', new Date(2026, 10, 10, 7, 0, 0).toISOString(), 'followup') // the user's own chat stays
    driver.missing.add('outpost-daily-gone')

    await runner.archiveOld(now)
    expect(driver.archived).toEqual(['outpost-daily-old'])

    await runner.archiveOld(now)
    expect(driver.archived).toEqual(['outpost-daily-old'])

    await runner.archiveOld(new Date(2026, 10, 26, 8, 0, 0))
    expect(driver.archived).toEqual(['outpost-daily-old', 'outpost-daily-recent'])
  })
})
