import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import { runDailyProduct } from '../../src/host/jobs/daily.ts'
import { JobRunner, type JobDeps, type RuntimeSettings } from '../../src/host/jobs/runner.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, completed, failure, instantClock, type Play, type Round } from '../fixtures/fake-driver.ts'

const DAY = '2026-11-24' // the day being processed; the clock already says the 25th (a catch-up after midnight)
const DAILY = 'outpost-daily-'
const VERIFY = 'outpost-verify-'

let dir: string
let db: Db
let repo: Repo
let driver: FakeDriver
let settings: RuntimeSettings
let deps: JobDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-daily-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  const { clock } = instantClock(new Date(2026, 10, 25, 0, 30, 0))
  repo = new Repo(db, () => clock.now())
  driver = new FakeDriver()
  settings = { maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, prices: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }, model: null }
  const runner = new JobRunner({ repo, driver, clock, settings: () => settings, log: vi.fn() })
  deps = { repo, runner, clock, icons: { fetch: vi.fn(async () => null) } }
  const track = repo.createTrack({ name: 'AI 编程助手', brief: '盯住编程类 Agent', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
  repo.upsertProduct({ id: 'p1', name: 'Cursor', company: 'Anysphere', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: ['cursor.com'], status: 'tracking', dailyBudgetYuan: null })
  repo.linkProduct(track.id, 'p1')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const source = { url: 'https://cursor.com/changelog/2-1', title: 'Cursor 2.1 更新日志', publisher: 'Cursor', publishedAt: '2026-11-24', kind: 'official', isOfficial: true, quote: 'Background agents are now generally available' }
const finding = { headline: 'Cursor 后台 Agent 正式上线', why: '不用守着编辑器也能让 Agent 改代码', importance: 'major', claimKind: 'self', dimensions: ['technology'], inference: false, sources: [source] }
const cardEdit = (findingId: string) => ({
  dimension: 'technology', summary: '后台 Agent 已正式上线', bullets: ['后台 Agent 正式上线'], body: 'Cursor 的后台 Agent 已正式上线[1]。', sources: [source],
  changeNote: '后台 Agent 转正', findingIds: [findingId],
})
/** A daily agent that reads, hands in one finding with a card edit on it, and ends. */
const oneFinding: Play = async r => {
  await r.call('outpost_read')
  const { findingId } = await r.call('outpost_submit_finding', finding) as { findingId: string }
  await r.call('outpost_propose_card_edit', cardEdit(findingId))
  await r.done('1 条新动态')
  return completed()
}
/** A checker that finds every quote on its page. */
const allSeen: Play = async r => {
  const pending = await r.call('outpost_read_pending') as Record<string, { sources: { sourceId: string }[] }[]>
  for (const s of Object.values(pending).flat().flatMap(i => i.sources))
    await r.call('outpost_report_check', { sourceId: s.sourceId, openedVia: 'http', quoteFound: true, supportsClaim: true })
  await r.done()
  return completed()
}
const runsOf = (kind: 'daily' | 'verify') => repo.runsOfDate(DAY, kind)

describe('runDailyProduct', () => {
  it('runs verify after the daily session', async () => {
    const events: string[] = []
    driver.script[DAILY] = async (r: Round) => { events.push('daily start'); const outcome = await oneFinding(r); events.push('daily end'); return outcome }
    driver.script[VERIFY] = async (r: Round) => { events.push('verify'); return allSeen(r) }

    const run = await runDailyProduct(deps, 'p1', DAY)

    expect(events).toEqual(['daily start', 'daily end', 'verify'])
    expect(driver.runs.map(s => s.title)).toEqual([`前哨 · Cursor 日更 ${DAY}`, `前哨 · Cursor 核查 ${DAY}`])
    expect(driver.runs[0]!.tools.map(t => t.name)).toEqual(['outpost_read', 'outpost_submit_finding', 'outpost_propose_card_edit', 'outpost_submit_facts', 'outpost_done'])
    expect(run).toMatchObject({ kind: 'daily', productId: 'p1', date: DAY, status: 'done', error: null })
    expect(runsOf('verify')).toMatchObject([{ productId: 'p1', status: 'done' }]) // the check counts toward the same day
    // The finding was checked and lands in that day's brief; the card edit on it became the dossier's first version.
    expect(repo.findingsOfDate(DAY)).toMatchObject([{ headline: finding.headline, status: 'verified', runId: run.id, verifiedOn: DAY }])
    expect(repo.latestCards('p1')).toMatchObject([{ dimension: 'technology', version: 1, changeNote: '后台 Agent 转正' }])
  })

  it('tells the agent to read first and to look only for what is new since its last run', async () => {
    const earlier = repo.createRun({ kind: 'daily', date: '2026-11-20', trackId: null, productId: 'p1' })
    repo.updateRun(earlier.id, { status: 'done' })
    const failed = repo.createRun({ kind: 'daily', date: '2026-11-23', trackId: null, productId: 'p1' })
    repo.updateRun(failed.id, { status: 'failed', error: '会话出错' })

    await runDailyProduct(deps, 'p1', DAY)

    const prompt = driver.runs[0]!.prompt
    expect(prompt).toContain('Cursor（Anysphere）')
    expect(prompt).toContain(DAY)
    expect(prompt).toContain('2026-11-20') // the last run that finished, not the failed one
    expect(prompt).not.toContain('2026-11-23')
    for (const word of ['outpost_read', 'outpost_submit_finding', 'outpost_propose_card_edit', "outpost_done('无新动态')"]) expect(prompt).toContain(word)
    expect(prompt).not.toMatch(/\{\{|\}\}/)
  })

  it('says when there is no earlier run to start from', async () => {
    await runDailyProduct(deps, 'p1', DAY)
    expect(driver.runs[0]!.prompt).toContain('没有记录')
  })

  it('ends without a check session when nothing is new', async () => {
    driver.script[DAILY] = async r => { await r.call('outpost_read'); await r.done('无新动态'); return completed() }

    const run = await runDailyProduct(deps, 'p1', DAY)

    expect(run.status).toBe('done')
    expect(driver.runs).toHaveLength(1)
    expect(runsOf('verify')).toEqual([])
  })

  it('does not check when the budget skipped the daily run', async () => {
    settings.dailyBudgetYuan = 0

    const run = await runDailyProduct(deps, 'p1', DAY)

    expect(run).toMatchObject({ status: 'skipped', error: '今日总预算已用完' })
    expect(driver.runs).toEqual([])
    expect(runsOf('verify')).toEqual([])
  })

  it('marks the product unfinished when the budget runs out before the check', async () => {
    driver.script[DAILY] = async r => { await oneFinding(r); return completed({ inputTokens: 10_000_000 }) } // ¥20: the whole budget

    const run = await runDailyProduct(deps, 'p1', DAY)

    expect(run).toMatchObject({ status: 'skipped', error: '核查没有完成：今日总预算已用完', costYuan: 20 })
    expect(runsOf('verify')).toMatchObject([{ status: 'skipped', error: '今日总预算已用完' }])
    expect(repo.findingsOfDate(DAY)).toMatchObject([{ status: 'pending' }]) // not shown, and checked next time
  })

  it('marks the product failed when the check fails', async () => {
    driver.script[DAILY] = oneFinding
    driver.script[VERIFY] = () => failure('模型返回了无法解析的内容')

    const run = await runDailyProduct(deps, 'p1', DAY)

    expect(run).toMatchObject({ status: 'failed', error: '核查没有完成：模型返回了无法解析的内容' })
    expect(repo.getRun(run.id)).toMatchObject({ status: 'failed' })
    expect(repo.findingsOfDate(DAY)).toMatchObject([{ status: 'pending' }])
    expect(repo.latestCards('p1')).toEqual([])
  })

  it('marks the product failed when the check stops without finishing', async () => {
    driver.script[DAILY] = oneFinding
    driver.script[VERIFY] = () => completed() // never calls outpost_done

    const run = await runDailyProduct(deps, 'p1', DAY)

    expect(run).toMatchObject({ status: 'failed', error: '核查没有完成：会话没有调用 outpost_done 就停了，这次不下结论' })
    expect(repo.findingsOfDate(DAY)).toMatchObject([{ status: 'pending' }]) // not 待确认 with a false 「原文打不开」
  })

  it('still checks what a failed daily session handed in', async () => {
    driver.script[DAILY] = async r => {
      await r.call('outpost_submit_finding', finding)
      return failure('模型返回了无法解析的内容')
    }
    driver.script[VERIFY] = allSeen

    const run = await runDailyProduct(deps, 'p1', DAY)

    expect(run).toMatchObject({ status: 'failed', error: '模型返回了无法解析的内容' }) // its own failure stands
    expect(repo.findingsOfDate(DAY)).toMatchObject([{ status: 'verified' }])
  })

  it('throws for a product that does not exist, starting nothing', async () => {
    await expect(runDailyProduct(deps, 'nope', DAY)).rejects.toThrow('nope')
    expect(driver.runs).toEqual([])
    expect(repo.runsOfDate(DAY)).toEqual([])
  })
})
