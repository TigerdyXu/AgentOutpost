import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { costOf } from '../../src/core/cost.ts'
import type { ModelRef } from '../../src/core/models.ts'
import type { Id, Product, Run } from '../../src/core/types.ts'
import { RESEARCH_PRESET_BROKEN } from '../../src/host/dsh-sessions.ts'
import { startFollowup } from '../../src/host/followup.ts'
import { JobRunner, NUDGE_TEXT, RELEASE_WAIT_MS, RETRY_DELAY_MS, isTransient, type RuntimeSettings, type SessionPlan } from '../../src/host/jobs/runner.ts'
import { researchTools } from '../../src/host/tools.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, completed, failure, flush, gate, instantClock, usage, type Play } from '../fixtures/fake-driver.ts'

const TODAY = '2026-11-25'
const PROMPT = '找 Cursor 近一天的新动态'
const PRICES = { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }

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
  settings = { maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, model: null, verifyModel: null, briefModel: null, followupModel: null, billingFor: () => 'metered', pricesOf: () => PRICES }
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

  it('starts a recommendation at once, outside the maxParallel places', async () => {
    settings.maxParallel = 1
    const track = repo.createTrack({ name: 'AI 编程助手', brief: '编程 Agent', dimensions: [], status: 'picking' })
    const recommend = (runId: Id): SessionPlan => ({
      title: '前哨 · 推荐 AI 编程助手',
      prompt: '找候选',
      tools: onDone => researchTools('recommend', { repo, runId, trackId: track.id, productId: null, now: () => time.clock.now(), icons: { fetch: async () => null }, onDone }),
    })
    const dailyHeld = gate()
    const recommendHeld = gate()
    driver.script['outpost-daily-'] = async r => { if (r.spec.title === '前哨 · p1 日更') await dailyHeld.promise; await r.done(); return completed() }
    driver.script['outpost-recommend-'] = async r => { await recommendHeld.promise; await r.done(); return completed() }

    // A long daily session holds the only place.
    const first = runner.start('daily', { productId: 'p1' }, build)
    await flush()
    expect(repo.getRun(first.run.id)!.status).toBe('running')

    // The recommendation does not wait for it…
    const rec = runner.start('recommend', { trackId: track.id }, recommend)
    await flush()
    expect(repo.getRun(rec.run.id)!.status).toBe('running')
    expect(driver.runs.map(s => s.title)).toEqual(['前哨 · p1 日更', '前哨 · 推荐 AI 编程助手'])
    recommendHeld.open()
    expect(await rec.finished).toMatchObject({ status: 'done', error: null, sessionId: `outpost-recommend-${rec.run.id.slice(0, 8)}` })
    expect(repo.getRun(first.run.id)!.status).toBe('running') // …and leaves the daily one alone

    // …nor does it take a place: with one running, the next daily still queues only behind the first daily.
    const second = gate()
    driver.script['outpost-recommend-'] = async r => { await second.promise; await r.done(); return completed() }
    const rec2 = runner.start('recommend', { trackId: track.id }, recommend)
    const next = runner.start('daily', { productId: 'p2' }, daily('p2'))
    await flush()
    expect(repo.getRun(next.run.id)!.status).toBe('queued')
    dailyHeld.open()
    expect(await first.finished).toMatchObject({ status: 'done', error: null })
    expect(await next.finished).toMatchObject({ status: 'done', error: null }) // ran while rec2 was still going
    expect(repo.getRun(rec2.run.id)!.status).toBe('running')
    second.open()
    expect(await rec2.finished).toMatchObject({ status: 'done' })
  })

  it('still holds a recommendation to the budget', async () => {
    repo.updateRun(seedRun.id, { costYuan: 20 })
    const run = await runner.session('recommend', { trackId: null }, build)
    expect(run).toMatchObject({ status: 'skipped', error: '今日总预算已用完' })
    expect(driver.runs).toHaveLength(0)
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

  it('fails a run at once, saying why, when the research preset cannot compose a session', async () => {
    let calls = 0
    driver.run = async () => { calls++; throw new Error(RESEARCH_PRESET_BROKEN) }
    const run = await runner.session('daily', { productId: 'p1' }, build)
    expect(run).toMatchObject({ status: 'failed', error: RESEARCH_PRESET_BROKEN })
    expect(calls).toBe(1) // not a passing failure: no retry, no wait, no nudge
    expect(time.waits).toEqual([])
    expect(driver.nudges).toEqual([])
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

  it('records cost from usage, searches and prices', async () => {
    driver.script['outpost-daily-'] = async r => {
      if (r.kind === 'run') return completed({ inputTokens: 1_000_000, outputTokens: 250_000, cacheReadTokens: 3_000_000, searches: 30 })
      await r.done()
      return completed({ inputTokens: 100_000, outputTokens: 50_000, searches: 7 })
    }
    const run = await runner.session('daily', { productId: 'p1' }, build)

    const total = { inputTokens: 1_100_000, outputTokens: 300_000, cacheReadTokens: 3_000_000, searches: 37 }
    expect(run.usage).toEqual(total)
    expect(run.costYuan).toBe(costOf(total, PRICES))
    // 1.1 × 2 + 0.3 × 8 + 3 × 0.04 = 4.72, and 37 searches × (8,000 × 2 + 800 × 8) / 1e6 = 0.8288
    expect(run.costYuan).toBe(5.5488)
    expect(repo.spentOn(TODAY, 'p1')).toBe(5.5488)
  })

  it('prices a run as a whole at the time it started, even when a round ends later', async () => {
    const asked: Date[] = []
    settings = { ...settings, pricesOf: (_model, at) => { asked.push(at); return PRICES } }
    const start = time.clock.now()
    driver.script['outpost-daily-'] = async r => {
      time.set(new Date(start.getTime() + 90 * 60_000)) // the round ends an hour and a half later
      await r.done()
      return completed({ inputTokens: 1_000 })
    }
    await runner.session('daily', { productId: 'p1' }, build)
    expect(asked.length).toBeGreaterThan(0)
    for (const at of asked) expect(at).toEqual(start)
  })

  it('settles a run in the step that stores it as over, before its session is let go of, and logs a settle that fails', async () => {
    const seen: { status: string; error: string | null; releasedYet: boolean }[] = []
    const settled = (fail = false) => (runId: Id): SessionPlan => ({
      ...build(runId),
      settle: run => {
        seen.push({ status: run.status, error: run.error, releasedYet: driver.released.includes(run.sessionId!) })
        if (fail) throw new Error('出错了')
        repo.updateRun(run.id, { error: '已处理' })
      },
    })
    driver.script['outpost-daily-'] = finishes()
    const run = await runner.session('daily', { productId: 'p1' }, settled())
    expect(seen).toEqual([{ status: 'done', error: null, releasedYet: false }])
    expect(run).toMatchObject({ status: 'done', error: '已处理' }) // what it settled is what comes back

    driver.script['outpost-daily-'] = () => failure('Invalid API key')
    const failed = await runner.session('daily', { productId: 'p1' }, settled(true))
    expect(seen[1]).toEqual({ status: 'failed', error: 'Invalid API key', releasedYet: false })
    expect(failed).toMatchObject({ status: 'failed', error: 'Invalid API key' }) // left as it ended
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`run ${failed.id} could not be settled`))

    // A run the budget refuses never had a session to settle.
    repo.updateRun(seedRun.id, { costYuan: 20 })
    expect(await runner.session('daily', { productId: 'p1' }, settled())).toMatchObject({ status: 'skipped' })
    expect(seen).toHaveLength(2)
  })

  it('releases a research session once its run is over', async () => {
    // What the run says when its session is let go of: the session's browser closes only after the run is settled.
    const statusAtRelease = new Map<string, string | undefined>()
    const record = driver.release.bind(driver)
    driver.release = async sessionId => {
      statusAtRelease.set(sessionId, repo.listRuns('').find(r => r.sessionId === sessionId)?.status)
      await record(sessionId)
    }
    const end = async (script: Play) => {
      driver.script['outpost-daily-'] = script
      const run = await runner.session('daily', { productId: 'p1' }, build)
      expect(driver.released.filter(id => id === run.sessionId)).toHaveLength(1) // once, by the time the run is back
      expect(statusAtRelease.get(run.sessionId!)).toBe(run.status)
      return run
    }

    expect(await end(finishes())).toMatchObject({ status: 'done', error: null })
    expect(await end(() => completed())).toMatchObject({ status: 'done', error: expect.stringContaining('outpost_done') }) // nudged, still not done
    expect(await end(() => failure('Invalid API key'))).toMatchObject({ status: 'failed' })
    expect(await end(() => ({ reason: 'timeout', usage: usage() }))).toMatchObject({ status: 'failed' })
    expect(await end(() => ({ reason: 'blocked', usage: usage() }))).toMatchObject({ status: 'failed' })
    expect(await end(() => ({ reason: 'aborted', usage: usage() }))).toMatchObject({ status: 'failed' })
    const retried = await end(() => failure('fetch failed: ECONNRESET'))
    expect(driver.runs.filter(s => s.sessionId === retried.sessionId)).toHaveLength(4) // released after the last retry only

    // Only after the nudge: the nudge goes to a session that is still live.
    driver.script['outpost-daily-'] = async r => {
      if (r.kind === 'nudge') { expect(driver.released).not.toContain(r.sessionId); await r.done('补交完毕') }
      return completed()
    }
    const nudged = await runner.session('daily', { productId: 'p1' }, build)
    expect(nudged.status).toBe('done') // a failed expect inside the nudge would have failed the run instead
    expect(driver.nudges.at(-1)).toEqual({ sessionId: nudged.sessionId, text: NUDGE_TEXT })
    expect(driver.released.at(-1)).toBe(nudged.sessionId)

    // A session DSH could not open at all is let go of too (whatever of it exists).
    const run = driver.run.bind(driver)
    driver.run = async () => { throw new Error('dsh-outpost: session "x" vanished right after it was created') }
    const broken = await runner.session('daily', { productId: 'p1' }, build)
    expect(broken.status).toBe('failed')
    expect(driver.released.at(-1)).toBe(broken.sessionId)
    driver.run = run

    // A run the budget refuses never had a session: nothing to let go of.
    const before = driver.released.length
    settings.dailyBudgetYuan = 0
    repo.updateRun(seedRun.id, { costYuan: 1 })
    expect((await runner.session('daily', { productId: 'p1' }, build)).status).toBe('skipped')
    expect(driver.released).toHaveLength(before)
  })

  it('lets the next queued session start only after the last one was released, and keeps a run whose release fails', async () => {
    settings.maxParallel = 1
    const events: string[] = []
    driver.script['outpost-daily-'] = async r => { events.push(`run ${r.spec.title}`); await r.done(); return completed() }
    driver.release = async sessionId => {
      events.push(`release ${driver.runs.find(s => s.sessionId === sessionId)!.title}`)
      throw new Error('DSH could not stop the browser')
    }
    const [a, b] = await Promise.all([runner.session('daily', { productId: 'p1' }, build), runner.session('daily', { productId: 'p2' }, daily('p2'))])
    expect(events).toEqual(['run 前哨 · p1 日更', 'release 前哨 · p1 日更', 'run 前哨 · p2 日更', 'release 前哨 · p2 日更'])
    expect([a.status, b.status]).toEqual(['done', 'done']) // a release that fails changes nothing about the run
    expect(log).toHaveBeenCalledWith(expect.stringContaining(a.sessionId!))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('DSH could not stop the browser'))
  })

  it('does not let a release that hangs hold up the sessions queued behind it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      settings.maxParallel = 1
      driver.script['outpost-daily-'] = finishes()
      let hung = false
      driver.release = async () => { if (!hung) { hung = true; await new Promise<void>(() => {}) } } // the first never ends
      const first = runner.session('daily', { productId: 'p1' }, build)
      const second = runner.session('daily', { productId: 'p2' }, daily('p2'))
      await flush(20)
      expect(driver.runs).toHaveLength(1) // the place is still held while the release may yet finish
      await vi.advanceTimersByTimeAsync(RELEASE_WAIT_MS)
      expect((await first).status).toBe('done')
      expect((await second).status).toBe('done') // went ahead
      expect(RELEASE_WAIT_MS).toBe(60_000)
      expect(log).toHaveBeenCalledWith(expect.stringContaining((await first).sessionId!))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not release a 追问 chat: it is the user\'s conversation', async () => {
    const run = repo.createRun({ kind: 'daily', date: TODAY, trackId: null, productId: 'p1' })
    const finding = repo.addFinding({
      productId: 'p1', runId: run.id, headline: '后台 Agent 正式上线', why: '不用守着编辑器', importance: 'major', claimKind: 'self',
      sourceIds: [], status: 'verified', statusNote: null, unconfirmedUntil: null, dimensions: [], inference: false,
      read: false, late: false, dedupeKey: 'k1', verifiedOn: TODAY,
    })
    const { sessionId } = await startFollowup({ repo, driver, clock: time.clock, icons: { fetch: async () => null }, settings: () => settings }, finding.id)
    driver.script['outpost-daily-'] = finishes()
    const research = await runner.session('daily', { productId: 'p1' }, build)
    await runner.idle()
    expect(driver.interactive.map(s => s.sessionId)).toEqual([sessionId])
    expect(driver.released).toEqual([research.sessionId])
    expect(driver.released).not.toContain(sessionId)
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
    // The session cut short is let go of; the queued run never had one.
    expect(driver.released).toEqual([(await first.finished).sessionId])
  })
})

describe('models', () => {
  const A: ModelRef = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const B: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const LOCAL: ModelRef = { provider: 'ollama', model: 'qwen3:8b' }
  const FREE = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0 }
  const kindOf = (sessionId: string) => sessionId.split('-')[1]

  it('runs a check on the verify model and research on the research model', async () => {
    settings.model = A
    settings.verifyModel = B
    driver.script['outpost-'] = finishes()
    await runner.session('daily', { productId: 'p1' }, build)
    await runner.session('verify', { productId: 'p1' }, build)
    await runner.session('baseline', { productId: 'p2' }, daily('p2'))
    await runner.session('recommend', { trackId: null }, build)
    // Recommendations, baselines and daily updates are all research.
    expect(driver.runs.map(s => [kindOf(s.sessionId), s.model])).toEqual([['daily', A], ['verify', B], ['baseline', A], ['recommend', A]])

    // No model of its own: the check runs on the research model, and with none either, on DSH's default (null).
    settings.verifyModel = null
    await runner.session('verify', { productId: 'p1' }, build)
    expect(driver.runs.at(-1)!.model).toEqual(A)
    settings.model = null
    await runner.session('verify', { productId: 'p1' }, build)
    expect(driver.runs.at(-1)!.model).toBeNull()
    // The other roles' models are not research's.
    settings.briefModel = B
    settings.followupModel = B
    await runner.session('daily', { productId: 'p1' }, build)
    expect(driver.runs.at(-1)!.model).toBeNull()
  })

  it('costs a run on a local model nothing and does not count it toward the budget', async () => {
    const priced: (ModelRef | null)[] = []
    settings.pricesOf = model => { priced.push(model); return model?.provider === 'ollama' ? FREE : PRICES }
    settings.maxParallel = 1
    settings.dailyBudgetYuan = 10
    driver.script['outpost-daily-'] = finishes({ outputTokens: 1_000_000 }) // 8 yuan at DeepSeek's prices

    settings.model = LOCAL
    const local = await runner.session('daily', { productId: 'p1' }, build)
    expect(local).toMatchObject({ status: 'done', usage: { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 }, costYuan: 0 })
    expect(priced.length).toBeGreaterThan(0)
    expect(priced.every(model => model === LOCAL)).toBe(true) // priced by the model the session ran on
    expect(repo.spentOn(TODAY)).toBe(0)

    // Back on DeepSeek (DSH's default model): spending adds up, and the budget stops the work as before.
    settings.model = null
    const first = await runner.session('daily', { productId: 'p1' }, build)
    const second = await runner.session('daily', { productId: 'p2' }, daily('p2')) // 8 < 10: the local run took none of it
    const third = await runner.session('daily', { productId: 'p2' }, daily('p2'))
    expect([first, second].map(r => [r.status, r.costYuan])).toEqual([['done', 8], ['done', 8]])
    expect(priced.at(-1)).toBeNull()
    expect(third).toMatchObject({ status: 'skipped', error: '今日总预算已用完' })
    expect(repo.spentOn(TODAY)).toBe(16)
  })

  it('starts a check on a local model when DeepSeek runs used the budget up, and still refuses DeepSeek research', async () => {
    // Research on DSH's default model (DeepSeek, metered); the check on a local model, which costs nothing.
    settings.verifyModel = LOCAL
    settings.billingFor = model => model?.provider === 'ollama' ? 'local' : 'metered'
    settings.pricesOf = model => model?.provider === 'ollama' ? FREE : PRICES
    settings.maxParallel = 1
    settings.dailyBudgetYuan = 5
    driver.script['outpost-'] = finishes()
    driver.script['outpost-daily-'] = finishes({ outputTokens: 1_000_000 }) // 8 yuan

    // A DeepSeek run holds the one place and spends the day's budget while a check and more research wait behind it:
    // looked at again once they get the place, the check still starts and the research does not.
    const [spender, check, research] = await Promise.all([
      runner.session('daily', { productId: 'p1' }, build),
      runner.session('verify', { productId: 'p2' }, daily('p2')),
      runner.session('daily', { productId: 'p2' }, daily('p2')),
    ])
    expect(spender).toMatchObject({ status: 'done', costYuan: 8 })
    expect(check).toMatchObject({ status: 'done', error: null, costYuan: 0 })
    expect(research).toMatchObject({ status: 'skipped', error: '今日总预算已用完', sessionId: null })

    // Asked when the budget is already spent: the same.
    expect(await runner.session('verify', { productId: 'p1' }, build)).toMatchObject({ status: 'done', costYuan: 0 })
    expect(await runner.session('daily', { productId: 'p1' }, build)).toMatchObject({ status: 'skipped', error: '今日总预算已用完' })

    // A product's own budget does not hold it back either.
    settings.dailyBudgetYuan = 100
    repo.upsertProduct({ id: 'p1', ...productSpec('Cursor', 'Anysphere', { dailyBudgetYuan: 1 }) })
    expect(await runner.session('verify', { productId: 'p1' }, build)).toMatchObject({ status: 'done' })
    expect(await runner.session('daily', { productId: 'p1' }, build)).toMatchObject({ status: 'skipped', error: '该产品今日预算已用完' })

    expect(driver.runs.map(s => [kindOf(s.sessionId), s.model])).toEqual([['daily', null], ['verify', LOCAL], ['verify', LOCAL], ['verify', LOCAL]])
    expect(repo.spentOn(TODAY)).toBe(8)
  })

  it('passes the configured model as is, even when DSH no longer offers it', async () => {
    // Ollama is not running, say: DSH lists none of its models. The runner neither checks the model nor swaps it for the
    // default; the session fails as DSH says, and the run with it.
    settings.model = LOCAL
    settings.verifyModel = { provider: 'lmstudio', model: 'removed-model' }
    const refusal = 'model "qwen3:8b" is not available from provider "ollama"'
    driver.script['outpost-daily-'] = () => failure(refusal)
    driver.script['outpost-verify-'] = finishes()

    const run = await runner.session('daily', { productId: 'p1' }, build)
    const check = await runner.session('verify', { productId: 'p1' }, build)

    expect(driver.runs.map(s => s.model)).toEqual([LOCAL, { provider: 'lmstudio', model: 'removed-model' }])
    expect(run).toMatchObject({ status: 'failed', error: refusal })
    expect(check).toMatchObject({ status: 'done' })
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

  it('archives sessions that ended more than a day ago, once', async () => {
    const now = new Date(2026, 10, 25, 8, 0, 0)
    ended('outpost-daily-old', new Date(2026, 10, 24, 7, 0, 0).toISOString())
    ended('outpost-daily-gone', new Date(2026, 10, 23, 7, 0, 0).toISOString())
    ended('outpost-daily-recent', new Date(2026, 10, 24, 9, 0, 0).toISOString())
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
