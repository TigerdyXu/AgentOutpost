import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Id } from '../../src/core/types.ts'
import { NO_CARDS_ERROR, baselineProducts, type BaselineDeps } from '../../src/host/jobs/baseline.ts'
import { VERIFY_BUDGET_NOTE, runDailyProduct } from '../../src/host/jobs/daily.ts'
import { JobRunner, type JobDeps, type RuntimeSettings } from '../../src/host/jobs/runner.ts'
import { appendLate, synthesizeBrief, type BriefDeps } from '../../src/host/jobs/synthesize.ts'
import { verifyProduct } from '../../src/host/jobs/verify.ts'
import type { ModelClient } from '../../src/host/ports.ts'
import { LAST_COMPLETED, Scheduler } from '../../src/host/scheduler.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, completed, usage, type Play } from '../fixtures/fake-driver.ts'
import { manualClock } from '../fixtures/manual-clock.ts'

const DAY = '2026-11-25'
const DAILY = 'outpost-daily-'
const VERIFY = 'outpost-verify-'
const BASELINE = 'outpost-baseline-'

let dir: string
let db: Db
let repo: Repo
let clock: ReturnType<typeof manualClock>
let driver: FakeDriver
let settings: RuntimeSettings & { runTime: string }
let runner: JobRunner
let log: ReturnType<typeof vi.fn<(message: string) => void>>
let complete: ReturnType<typeof vi.fn<ModelClient['complete']>>
let scheduler: Scheduler
let calls: { runDailyProduct: { productId: Id; date: string }[] }
let trackId: Id

const addProduct = (id: Id, name: string, status: 'tracking' | 'baselining' = 'tracking', withCard = true) => {
  repo.upsertProduct({ id, name, company: `${name} Inc`, region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [`${name.toLowerCase()}.com`], status, dailyBudgetYuan: null })
  repo.linkProduct(trackId, id)
  if (withCard) repo.addCardVersion({ productId: id, dimension: 'positioning', version: 1, summary: '编辑器', bullets: ['基于 VS Code'], body: '编辑器[1]', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-20T00:00:00.000Z' })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-daily-flow-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  clock = manualClock('2026-11-25T08:00')
  repo = new Repo(db, () => clock.clock.now())
  driver = new FakeDriver()
  // One product at a time, so that the order in which the budget runs out is the tracking order.
  settings = { runTime: '08:00', maxParallel: 1, dailyBudgetYuan: 20, sessionTimeoutMin: 30, model: null, verifyModel: null, briefModel: null, followupModel: null, billingFor: () => 'metered', pricesOf: () => ({ inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }) }
  log = vi.fn<(message: string) => void>()
  runner = new JobRunner({ repo, driver, clock: clock.clock, settings: () => settings, log })
  complete = vi.fn<ModelClient['complete']>(async () => ({ text: 'Cursor 后台 Agent 正式上线。', usage: usage({ inputTokens: 1000, outputTokens: 20 }) }))
  const jobs: JobDeps = { repo, runner, clock: clock.clock, icons: { fetch: vi.fn(async () => null) } }
  const baselines: BaselineDeps = { ...jobs, verifyProduct: (productId, scope) => verifyProduct(jobs, productId, scope) }
  const briefs: BriefDeps = { repo, model: { complete }, clock: clock.clock, settings: () => settings }
  calls = { runDailyProduct: [] }
  scheduler = new Scheduler({
    clock: clock.clock,
    repo,
    settings: () => settings,
    runDailyProduct: (productId, date) => { calls.runDailyProduct.push({ productId, date }); return runDailyProduct(jobs, productId, date) },
    synthesize: date => synthesizeBrief(briefs, date),
    appendLate: (date, productId) => appendLate(briefs, date, productId),
    archiveOld: now => runner.archiveOld(now),
    rebaseline: ids => baselineProducts(baselines, ids),
    verifyProduct: (productId, date) => verifyProduct(jobs, productId, 'daily', date),
    log,
  })
  trackId = repo.createTrack({ name: 'AI 编程助手', brief: '盯住编程类 Agent', dimensions: [{ key: 'positioning', label: '定位' }], status: 'active' }).id
  addProduct('p1', 'Cursor')
  addProduct('p2', 'Windsurf')
  addProduct('p3', 'Cline')
})
afterEach(async () => {
  scheduler.stop()
  await runner.stop()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const source = { url: 'https://cursor.com/changelog/2-1', title: 'Cursor 2.1 更新日志', publisher: 'Cursor', publishedAt: '2026-11-24', kind: 'official', isOfficial: true, quote: 'Background agents are now generally available' }
const finding = { headline: 'Cursor 后台 Agent 正式上线', why: '不用守着编辑器也能让 Agent 改代码', importance: 'major', claimKind: 'self', dimensions: [], inference: false, sources: [source] }
/** Cursor hands in one finding; the others find nothing new. Each session costs `yuan`. */
const dailyAgent = (yuan: number): Play => async r => {
  await r.call('outpost_read')
  if (r.spec.title.includes('Cursor')) await r.call('outpost_submit_finding', finding)
  await r.done(r.spec.title.includes('Cursor') ? '1 条新动态' : '无新动态')
  return completed({ inputTokens: Math.round(yuan * 500_000) }) // ¥2 per million input tokens
}
/** A checker that finds every quote on its page. */
const allSeen: Play = async r => {
  const pending = await r.call('outpost_read_pending') as Record<string, { sources: { sourceId: string; needsCheck: boolean }[] }[]>
  for (const s of Object.values(pending).flat().flatMap(i => i.sources).filter(s => s.needsCheck))
    await r.call('outpost_report_check', { sourceId: s.sourceId, openedVia: 'http', quoteFound: true, supportsClaim: true })
  await r.done()
  return completed()
}

describe('one day, end to end', () => {
  it('names budget-skipped products in the brief', async () => {   // daily-flow.spec.ts
    driver.script[DAILY] = async r => { await r.call('outpost_read'); await r.done('无新动态'); return completed({ inputTokens: 10_000 }) } // ¥0.02
    settings.dailyBudgetYuan = 0.01; await scheduler.runDay('2026-11-25')
    const brief = repo.getBrief('2026-11-25')!
    expect(brief.skipped.map(s => s.reason)).toEqual(['今日总预算已用完', '今日总预算已用完'])
    expect(calls.runDailyProduct).toHaveLength(1)

    // The rest are named, not run, and nothing is reported as an error.
    expect(brief.skipped).toEqual([{ productId: 'p2', reason: '今日总预算已用完' }, { productId: 'p3', reason: '今日总预算已用完' }])
    expect(brief.quietProductIds).toEqual(['p1'])
    expect(repo.runsOfDate(DAY, 'daily').map(r => [r.productId, r.status])).toEqual([['p1', 'done'], ['p2', 'skipped'], ['p3', 'skipped']])
    expect(repo.runsOfDate(DAY).filter(r => r.status === 'failed')).toEqual([])
    expect(driver.runs.map(s => s.title)).toEqual([`前哨 · Cursor 日更 ${DAY}`])
    expect(log).not.toHaveBeenCalled()
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY) // a day the budget cut short is still over
  })

  it('runs every tracked product, checks what it found, and writes the brief, all counted toward the day processed', async () => {
    clock.set('2026-11-26T00:30') // a catch-up after midnight: the work still belongs to the 25th
    driver.script[DAILY] = dailyAgent(0.5)
    driver.script[VERIFY] = allSeen

    await scheduler.runDay(DAY)

    const brief = repo.getBrief(DAY)!
    const [news] = repo.findingsOfDate(DAY)
    expect(news).toMatchObject({ headline: finding.headline, status: 'verified', verifiedOn: DAY, late: false })
    expect(brief).toMatchObject({ gist: 'Cursor 后台 Agent 正式上线。', findingIds: [news!.id], quietProductIds: ['p2', 'p3'], skipped: [] })
    expect(repo.runsOfDate(DAY).map(r => `${r.kind} ${r.status}`)).toEqual(['daily done', 'verify done', 'daily done', 'daily done', 'synthesize done'])
    expect(repo.runsOfDate('2026-11-26')).toEqual([])
    expect(brief.costYuan).toBeCloseTo(repo.spentOn(DAY), 6)
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
  })

  it('finishes a product whose check the budget did not allow, names it, and does not run it again', async () => {
    driver.script[DAILY] = dailyAgent(20) // Cursor's session alone uses the whole day's budget

    await scheduler.runDay(DAY)

    expect(repo.runsOfDate(DAY, 'daily')[0]).toMatchObject({ productId: 'p1', status: 'done', error: VERIFY_BUDGET_NOTE })
    expect(repo.findingsOfDate(DAY)).toMatchObject([{ status: 'pending' }]) // checked by the next day's check
    const brief = repo.getBrief(DAY)!
    expect(brief.findingIds).toEqual([])
    expect(brief.skipped).toEqual([
      { productId: 'p1', reason: VERIFY_BUDGET_NOTE },
      { productId: 'p2', reason: '今日总预算已用完' },
      { productId: 'p3', reason: '今日总预算已用完' },
    ])

    await scheduler.runDay(DAY)
    expect(calls.runDailyProduct).toHaveLength(1)
  })

  it('keeps a product whose baseline handed in nothing 建档中, and baselines it again the next day', async () => {
    addProduct('p4', 'Zed', 'baselining', false)
    driver.script[BASELINE] = async () => completed() // hands in nothing, never calls outpost_done

    await scheduler.runDay(DAY)
    await runner.idle()

    expect(repo.getProduct('p4')!.status).toBe('baselining')
    expect(repo.runsOfDate(DAY, 'baseline')).toMatchObject([{ productId: 'p4', status: 'failed', error: NO_CARDS_ERROR }])
    expect(calls.runDailyProduct.map(c => c.productId)).toEqual(['p1', 'p2', 'p3'])

    driver.script[BASELINE] = async r => {
      await r.call('outpost_submit_card', { dimension: 'positioning', summary: '编辑器', bullets: ['用 Rust 写的编辑器'], body: 'Zed 是用 Rust 写的编辑器[1]。', sources: [{ ...source, url: 'https://zed.com/', title: 'Zed 官网', publisher: 'Zed', quote: 'Zed is a high-performance editor' }] })
      await r.done()
      return completed()
    }
    driver.script[VERIFY] = allSeen
    clock.set('2026-11-26T08:00')
    await scheduler.runDay('2026-11-26')
    await runner.idle()

    expect(repo.getProduct('p4')!.status).toBe('tracking')
    expect(repo.latestCards('p4')).toMatchObject([{ dimension: 'positioning', version: 1 }])
  })
})
