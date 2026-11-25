import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localDate } from '../../src/core/calendar.ts'
import { UNCONFIRMED_WINDOW_DAYS } from '../../src/core/credibility.ts'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { CardEdit, Finding, OpenedVia, Source, Span } from '../../src/core/types.ts'
import { startBaseline, type VerifyProduct } from '../../src/host/jobs/baseline.ts'
import { JobRunner, type JobDeps, type RuntimeSettings } from '../../src/host/jobs/runner.ts'
import { VerifyNotRun, renumberCitations, verifyProduct, withoutSources } from '../../src/host/jobs/verify.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, completed, failure, instantClock, type Play, type Round } from '../fixtures/fake-driver.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const START = new Date(2026, 10, 25, 9, 0, 0) // local wall clock: 2026-11-25 09:00
const TODAY = '2026-11-25'
const VERIFY = 'outpost-verify-'

let dir: string
let db: Db
let repo: Repo
let driver: FakeDriver
let runner: JobRunner
let settings: RuntimeSettings
let time: ReturnType<typeof instantClock>
let deps: JobDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-verify-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  time = instantClock(START)
  repo = new Repo(db, () => time.clock.now())
  driver = new FakeDriver()
  settings = { maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, prices: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }, model: null }
  runner = new JobRunner({ repo, driver, clock: time.clock, settings: () => settings, log: vi.fn() })
  deps = { repo, runner, clock: time.clock, icons: { fetch: vi.fn(async () => null) } }
  const track = repo.createTrack({ name: 'AI 编程助手', brief: '盯住编程类 Agent', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
  repo.upsertProduct({ id: 'p1', name: 'Cursor', company: 'Anysphere', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: ['cursor.com'], status: 'tracking', dailyBudgetYuan: null })
  repo.linkProduct(track.id, 'p1')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ---- the world as an earlier daily or baseline session left it ----

const daysAfterStart = (days: number) => new Date(START.getTime() + days * DAY_MS)
const dailyRun = (date = TODAY) => repo.createRun({ kind: 'daily', date, trackId: null, productId: 'p1' })
const addSource = (url: string, over: Partial<Omit<Source, 'id' | 'url'>> = {}): Source => repo.addSource({
  url, title: '报道', publisher: '某媒体', publishedAt: null, kind: 'media', isOfficial: false, quote: `${url} 的原话`,
  syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null, ...over,
})
const official = (url: string) => addSource(url, { kind: 'official', isOfficial: true, publisher: 'Cursor' })
const addFinding = (sources: Source[], over: Partial<Omit<Finding, 'id' | 'createdAt' | 'sourceIds'>> = {}): Finding => repo.addFinding({
  productId: 'p1', runId: dailyRun().id, headline: 'Cursor 推出团队定价', why: '团队版每人每月 40 美元', importance: 'major', claimKind: 'self',
  sourceIds: sources.map(s => s.id), status: 'pending', statusNote: null, unconfirmedUntil: null, dimensions: ['business'], inference: false,
  read: false, late: false, dedupeKey: `key-${sources[0]?.url}`, ...over,
})
const addEdit = (over: Partial<Omit<CardEdit, 'id' | 'status'>> = {}): CardEdit => repo.addCardEdit({
  productId: 'p1', dimension: 'business', summary: '团队版按人收费', bullets: ['团队版 40 美元'], body: '团队版每人每月 40 美元[1]。',
  inferenceSpans: [], changeNote: '新增团队定价', findingIds: [], ...over,
  sourceIds: over.sourceIds ?? [official('https://cursor.com/pricing').id],
})
const finding = (id: string) => repo.findingsOfProduct('p1').find(f => f.id === id)!
const card = (dimension: string) => repo.latestCards('p1').find(c => c.dimension === dimension)
const spanText = (body: string, spans: Span[]) => spans.map(s => body.slice(s.start, s.end))

// ---- the checker, scripted ----

interface PendingSource { sourceId: string; url: string; quote: string }
interface PendingItem { itemId: string; claimKind: string | null; claim: string; sources: PendingSource[] }
interface Pending { pendingFindings: PendingItem[]; pendingCardEdits: PendingItem[]; unconfirmedFindings: PendingItem[] }
interface Check { openedVia: OpenedVia; quoteFound: boolean | null; supportsClaim?: boolean | null; syndicationGroup?: string | null }

const readPending = async (r: Round) => await r.call('outpost_read_pending') as Pending
const everySource = (p: Pending) => [...p.pendingFindings, ...p.pendingCardEdits, ...p.unconfirmedFindings].flatMap(i => i.sources)
/** A check session that reports `check` (or what it gives for the source; null: says nothing) for every source waiting, then ends. */
const reportCheck = (check: Check | ((s: PendingSource) => Check | null)): Play => async r => {
  for (const s of everySource(await readPending(r))) {
    const report = typeof check === 'function' ? check(s) : check
    if (report) await r.call('outpost_report_check', { sourceId: s.sourceId, supportsClaim: null, ...report })
  }
  await r.done()
  return completed()
}
const SEEN: Check = { openedVia: 'http', quoteFound: true, supportsClaim: true }
const NOT_THERE: Check = { openedVia: 'http', quoteFound: false, supportsClaim: null }
const UNOPENED: Check = { openedVia: 'unopened', quoteFound: null }

describe('verifyProduct', () => {
  it('marks a 公众号 finding 原文打不开 and keeps it out of the dossier', async () => {
    const wechat = official('https://mp.weixin.qq.com/s?__biz=MzA3&mid=2650&idx=1&sn=abc')
    const f = addFinding([wechat])
    addEdit({ findingIds: [f.id] })
    driver.script[VERIFY] = reportCheck(UNOPENED) // no browser in this session: plain fetch hit the verification page

    await verifyProduct(deps, 'p1', 'daily')

    expect(repo.findingsOfProduct('p1')[0]).toMatchObject({ status: 'unconfirmed', statusNote: '原文打不开', unconfirmedUntil: daysAfterStart(UNCONFIRMED_WINDOW_DAYS).toISOString() })
    expect(repo.pendingCardEdits('p1')).toHaveLength(1) // waits for its finding: not applied, not thrown away
    expect(repo.latestCards('p1')).toEqual([])
    const run = repo.runsOfDate(TODAY, 'verify')[0]!
    expect(run).toMatchObject({ status: 'done', productId: 'p1', sessionId: `outpost-verify-${run.id.slice(0, 8)}` })
    expect(driver.runs[0]!.title).toBe(`前哨 · Cursor 核查 ${TODAY}`)
    expect(driver.runs[0]!.tools.map(t => t.name)).toEqual(['outpost_read_pending', 'outpost_report_check', 'outpost_add_source', 'outpost_done'])
  })

  it('applies a card edit once all its findings are verified', async () => {
    time.set(daysAfterStart(-10))
    repo.addCardVersion({ productId: 'p1', dimension: 'business', version: 1, summary: '个人版免费', bullets: ['个人版免费'], body: '个人版免费[1]。', sourceIds: [addSource('https://cursor.com/pricing').id], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: time.clock.now().toISOString() })
    time.set(START)
    const changelog = official('https://cursor.com/changelog/2-0')
    const selfClaim = addFinding([changelog]) // official, about itself: one source is enough
    const reportA = addSource('https://news-a.example/cursor-teams')
    const reportB = addSource('https://news-b.example/cursor-teams')
    const thirdParty = addFinding([reportA, reportB], { claimKind: 'third-party', headline: '团队版上线首周 1 万家企业订阅', dedupeKey: 'k2' })
    const newBody = '个人版免费[1]。团队版每人每月 40 美元[2]，上线首周 1 万家企业订阅[3]。'
    const editSources = [addSource('https://cursor.com/pricing'), official('https://cursor.com/changelog/2-0'), addSource('https://news-a.example/cursor-teams')]
    const edit = addEdit({ body: newBody, sourceIds: editSources.map(s => s.id), findingIds: [selfClaim.id, thirdParty.id] })

    // Day one: the reports would not open, so the third-party claim waits and so does the edit.
    driver.script[VERIFY] = reportCheck(s => s.url.includes('news-') ? UNOPENED : SEEN)
    await verifyProduct(deps, 'p1', 'daily')
    expect([finding(selfClaim.id).status, finding(thirdParty.id).status]).toEqual(['verified', 'unconfirmed'])
    expect(repo.pendingCardEdits('p1').map(e => e.id)).toEqual([edit.id])
    expect(card('business')!.version).toBe(1)

    // Day two: both reports open and hold the quote. Every finding is verified now, so the edit becomes version 2.
    time.set(daysAfterStart(1))
    driver.script[VERIFY] = reportCheck(SEEN)
    await verifyProduct(deps, 'p1', 'daily')
    expect(finding(thirdParty.id)).toMatchObject({ status: 'verified', unconfirmedUntil: null })
    expect(repo.pendingCardEdits('p1')).toEqual([])
    const v2 = card('business')!
    expect(v2).toMatchObject({ version: 2, body: newBody, sourceIds: edit.sourceIds, findingIds: [selfClaim.id, thirdParty.id], changeNote: '新增团队定价', createdAt: daysAfterStart(1).toISOString() })
    expect(spanText(v2.body, v2.addedSpans).join('')).toContain('团队版每人每月 40 美元[2]') // the reader sees what is new
    expect(repo.cardHistory('p1', 'business').map(c => c.version)).toEqual([1, 2]) // version 1 is kept
  })

  it('promotes an unconfirmed finding when a second source is added later', async () => {
    const first = addSource('https://36kr.example/p/1')
    const f = addFinding([first], { claimKind: 'third-party', headline: 'Cursor 年收入破 5 亿美元' })
    const edit = addEdit({ dimension: 'business', body: '年收入已破 5 亿美元[1]。', sourceIds: [addSource('https://36kr.example/p/1').id], findingIds: [f.id] })
    driver.script[VERIFY] = reportCheck(SEEN)
    await verifyProduct(deps, 'p1', 'daily')
    expect(finding(f.id)).toMatchObject({ status: 'unconfirmed', statusNote: '只有一个来源' })
    expect(repo.pendingCardEdits('p1')).toHaveLength(1)

    // Three days later the checker finds an independent second report and confirms it.
    time.set(daysAfterStart(3))
    let offered: Pending | undefined
    driver.script[VERIFY] = async r => {
      offered = await readPending(r)
      const added = await r.call('outpost_add_source', {
        itemId: f.id,
        source: { url: 'https://www.theinformation.example/cursor-revenue', title: 'Cursor 收入', publisher: 'The Information', publishedAt: null, kind: 'media', isOfficial: false, quote: 'annualized revenue passed $500 million' },
      }) as { sourceId: string }
      await r.call('outpost_report_check', { sourceId: added.sourceId, ...SEEN })
      await r.done()
      return completed()
    }
    await verifyProduct(deps, 'p1', 'daily')

    expect(offered!.unconfirmedFindings.map(i => i.itemId)).toEqual([f.id])
    expect(finding(f.id)).toMatchObject({ status: 'verified', statusNote: '已证实', unconfirmedUntil: null })
    expect(finding(f.id).sourceIds).toHaveLength(2)
    expect(repo.pendingCardEdits('p1')).toEqual([])
    expect(card('business')).toMatchObject({ version: 1, findingIds: [f.id], sourceIds: edit.sourceIds }) // 转正：写进档案
  })

  it('expires an unconfirmed finding to unproven after 7 days', async () => {
    const old = addFinding([addSource('https://news.example/rumor-1')], { claimKind: 'third-party', headline: '传闻：Cursor 将推出手机版' })
    addEdit({ dimension: 'positioning', findingIds: [old.id] })
    driver.script[VERIFY] = reportCheck(SEEN)
    await verifyProduct(deps, 'p1', 'daily')
    expect(finding(old.id).status).toBe('unconfirmed')

    time.set(daysAfterStart(3))
    const younger = addFinding([addSource('https://news.example/rumor-2')], { claimKind: 'third-party', headline: '传闻：Cursor 将开源', dedupeKey: 'k2' })
    await verifyProduct(deps, 'p1', 'daily')
    expect(finding(younger.id).status).toBe('unconfirmed')

    // A minute past the old one's 7 days: it is 未证实 before the checker starts, so no searching is spent on it.
    time.set(new Date(daysAfterStart(UNCONFIRMED_WINDOW_DAYS).getTime() + 60_000))
    let offered: Pending | undefined
    driver.script[VERIFY] = async r => { offered = await readPending(r); await r.done(); return completed() }
    await verifyProduct(deps, 'p1', 'daily')

    expect(offered!.unconfirmedFindings.map(i => i.itemId)).toEqual([younger.id])
    expect(finding(old.id)).toMatchObject({ status: 'unproven', statusNote: '只有一个来源', unconfirmedUntil: daysAfterStart(UNCONFIRMED_WINDOW_DAYS).toISOString() })
    expect(finding(younger.id)).toMatchObject({ status: 'unconfirmed', unconfirmedUntil: daysAfterStart(3 + UNCONFIRMED_WINDOW_DAYS).toISOString() })
    expect(repo.pendingCardEdits('p1')).toEqual([]) // the edit resting on it is rejected, not kept forever
    expect(card('positioning')).toBeUndefined()
  })

  it('strips a withdrawn source and renumbers citations in a baseline card', async () => {
    expect(renumberCitations('甲[1]乙[2]丙[3]', [2])).toBe('甲[1]乙丙[2]')

    const body = 'Cursor 是基于 VS Code 的编辑器[1]。有评测说它比同类快一倍[2]。估计它会继续走企业路线[3]。'
    const sources = [official('https://cursor.com/'), addSource('https://blog.example/review'), addSource('https://news.example/enterprise')]
    const inference = '估计它会继续走企业路线[3]'
    const start = body.indexOf(inference)
    const edit = addEdit({ dimension: 'positioning', summary: '面向专业开发者的 AI 编辑器', bullets: ['基于 VS Code'], body, sourceIds: sources.map(s => s.id), inferenceSpans: [{ start, end: start + inference.length }], changeNote: '建档' })
    driver.script[VERIFY] = reportCheck(s => s.sourceId === sources[1]!.id ? NOT_THERE : SEEN) // the review page does not say so

    await verifyProduct(deps, 'p1', 'baseline')

    const v1 = card('positioning')!
    expect(v1).toMatchObject({
      version: 1, body: 'Cursor 是基于 VS Code 的编辑器[1]。有评测说它比同类快一倍。估计它会继续走企业路线[2]。',
      sourceIds: [sources[0]!.id, sources[2]!.id], addedSpans: [], changeNote: '建档', findingIds: [],
    })
    expect(spanText(v1.body, v1.inferenceSpans)).toEqual(['估计它会继续走企业路线[2]']) // the 推论 mark still covers the same words
    expect(repo.pendingCardEdits('p1')).toEqual([])
    expect(repo.cardHistory('p1', 'positioning')).toHaveLength(1)
    expect(edit.sourceIds).toHaveLength(3) // the edit itself is kept as it was handed in
  })

  it('rejects a baseline card with no valid source', async () => {
    const quoteMissing = addSource('https://blog.example/a')
    const wechat = addSource('https://mp.weixin.qq.com/s?__biz=MzB&mid=1&idx=1&sn=x')
    addEdit({ dimension: 'experience', summary: '上手快', body: '上手快[1]，口碑好[2]。', sourceIds: [quoteMissing.id, wechat.id], changeNote: '建档' })
    const good = official('https://cursor.com/features')
    addEdit({ dimension: 'technology', summary: '自研补全模型', body: '用自研模型做补全[1]。', sourceIds: [good.id], changeNote: '建档' })
    driver.script[VERIFY] = reportCheck(s => s.sourceId === quoteMissing.id ? NOT_THERE : s.sourceId === wechat.id ? UNOPENED : SEEN)

    await verifyProduct(deps, 'p1', 'baseline')

    // Neither source can back 体验: one does not hold the quote, the other was never seen. The dimension stays empty
    // (the dossier shows 「暂无可核实的信息」); the other card of the same run is unaffected.
    expect(card('experience')).toBeUndefined()
    expect(card('technology')).toMatchObject({ version: 1, sourceIds: [good.id] })
    expect(repo.pendingCardEdits('p1')).toEqual([])
  })

  it('drops a source the check found void from a daily card edit it applies', async () => {
    const f = addFinding([official('https://cursor.com/changelog/2-0')])
    const sources = [official('https://cursor.com/changelog/2-0'), addSource('https://blog.example/guess')]
    addEdit({ body: '团队版每人每月 40 美元[1]，据说还会降价[2]。', sourceIds: sources.map(s => s.id), findingIds: [f.id] })
    driver.script[VERIFY] = reportCheck(s => s.sourceId === sources[1]!.id ? NOT_THERE : SEEN)

    await verifyProduct(deps, 'p1', 'daily')

    expect(card('business')).toMatchObject({ version: 1, body: '团队版每人每月 40 美元[1]，据说还会降价。', sourceIds: [sources[0]!.id] })
  })

  it('withdraws a finding the page does not back, and rejects the edit resting on it', async () => {
    const f = addFinding([official('https://cursor.com/changelog/2-1')])
    addEdit({ findingIds: [f.id] })
    driver.script[VERIFY] = reportCheck(s => s.url.includes('changelog') ? { openedVia: 'browser', quoteFound: true, supportsClaim: false } : SEEN)

    await verifyProduct(deps, 'p1', 'daily')

    expect(finding(f.id)).toMatchObject({ status: 'withdrawn', statusNote: '引句在原文中找不到或不支持结论' })
    expect(repo.pendingCardEdits('p1')).toEqual([])
    expect(card('business')).toBeUndefined()
  })

  it('counts a source the checker never reported on as not opened', async () => {
    const f = addFinding([official('https://cursor.com/blog/agents')])
    driver.script[VERIFY] = async r => { await readPending(r); await r.done('忘了报告'); return completed() }

    await verifyProduct(deps, 'p1', 'daily')

    // Nobody looked at the page: it neither backs nor voids the finding, which waits and is tried again tomorrow.
    expect(finding(f.id)).toMatchObject({ status: 'unconfirmed', statusNote: '原文打不开' })
  })

  it('lets the newest of two edits to one dimension win', async () => {
    const f = addFinding([official('https://cursor.com/changelog/2-0')])
    const older = addEdit({ body: '团队版 40 美元[1]。', findingIds: [f.id] })
    const newer = addEdit({ body: '团队版每人每月 40 美元，按年付 32 美元[1]。', findingIds: [f.id] })
    driver.script[VERIFY] = reportCheck(SEEN)

    await verifyProduct(deps, 'p1', 'daily')

    expect(repo.cardHistory('p1', 'business').map(c => [c.version, c.body])).toEqual([[1, newer.body]]) // not [[1, older], [2, newer]]
    expect(older.body).not.toBe(newer.body)
    expect(repo.pendingCardEdits('p1')).toEqual([]) // the older one is rejected, not left to overwrite the newer one later
  })

  it('starts no session when nothing waits for the checker', async () => {
    const old = addFinding([addSource('https://news.example/rumor')], { claimKind: 'third-party', status: 'unconfirmed', statusNote: '只有一个来源' })
    addFinding([official('https://cursor.com/a')], { status: 'verified', dedupeKey: 'k2' })

    await verifyProduct(deps, 'p1', 'daily') // within 7 days: waits for the next check with a session
    expect(driver.runs).toHaveLength(1)

    time.set(daysAfterStart(UNCONFIRMED_WINDOW_DAYS + 1))
    await verifyProduct(deps, 'p1', 'daily') // only an expired one left: settled without the agent
    expect(driver.runs).toHaveLength(1)
    expect(finding(old.id).status).toBe('unproven')
    expect(repo.runsOfDate(localDate(daysAfterStart(UNCONFIRMED_WINDOW_DAYS + 1)), 'verify')).toEqual([])
  })

  it('rejects when the check was skipped for the budget, leaving everything as it was', async () => {
    const f = addFinding([official('https://cursor.com/changelog/2-0')])
    addEdit({ findingIds: [f.id] })
    settings.dailyBudgetYuan = 0

    const error = await verifyProduct(deps, 'p1', 'daily').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(VerifyNotRun)
    expect((error as VerifyNotRun).message).toBe('今日总预算已用完')
    expect((error as VerifyNotRun).run).toMatchObject({ kind: 'verify', status: 'skipped' })
    expect(finding(f.id).status).toBe('pending')
    expect(repo.pendingCardEdits('p1')).toHaveLength(1)
    expect(driver.runs).toEqual([])
  })

  it('rejects when the check session failed, judging nothing on half a report', async () => {
    const f = addFinding([official('https://cursor.com/changelog/2-0')])
    driver.script[VERIFY] = async r => {
      for (const s of everySource(await readPending(r))) await r.call('outpost_report_check', { sourceId: s.sourceId, ...SEEN })
      return failure('模型返回了无法解析的内容')
    }

    await expect(verifyProduct(deps, 'p1', 'daily')).rejects.toThrow('模型返回了无法解析的内容')

    expect(finding(f.id).status).toBe('pending')
    expect(repo.runsOfDate(TODAY, 'verify')[0]).toMatchObject({ status: 'failed' })
  })

  it('counts the check toward the day it is given', async () => {
    addFinding([official('https://cursor.com/changelog/2-0')])
    driver.script[VERIFY] = reportCheck(SEEN)
    await verifyProduct(deps, 'p1', 'daily', '2026-11-24')
    expect(repo.runsOfDate('2026-11-24', 'verify')).toHaveLength(1)
    expect(driver.runs[0]!.title).toBe('前哨 · Cursor 核查 2026-11-24')
  })

  it('tells the checker the product and the order of the steps', async () => {
    addFinding([official('https://cursor.com/changelog/2-0')])
    driver.script[VERIFY] = reportCheck(SEEN)
    await verifyProduct(deps, 'p1', 'baseline')
    const prompt = driver.runs[0]!.prompt
    expect(prompt).toContain('Cursor（Anysphere）')
    expect(prompt).toContain('cursor.com')
    expect(prompt).not.toMatch(/\{\{|\}\}/)
    const steps = prompt.slice(prompt.indexOf('## 步骤'))
    const order = ['outpost_read_pending', 'web_fetch', '浏览器', '摘要', 'outpost_report_check', 'outpost_add_source', 'outpost_done'].map(word => steps.indexOf(word))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('takes a product from baseline to its first dossier when injected into the baseline', async () => {
    const verify: VerifyProduct = (productId, scope) => verifyProduct(deps, productId, scope)
    repo.setProductStatus('p1', 'candidate')
    driver.script['outpost-baseline-'] = async r => {
      await r.call('outpost_submit_card', {
        dimension: 'positioning', summary: '面向专业开发者的 AI 编辑器', bullets: ['基于 VS Code'], body: 'Cursor 是基于 VS Code 的编辑器[1]。',
        sources: [{ url: 'https://cursor.com/', title: 'Cursor 官网', publisher: 'Cursor', publishedAt: null, kind: 'official', isOfficial: true, quote: 'The AI Code Editor' }],
      })
      await r.done()
      return completed()
    }
    driver.script[VERIFY] = reportCheck(SEEN)

    startBaseline({ ...deps, verifyProduct: verify }, ['p1'])
    await runner.idle()

    expect(repo.getProduct('p1')!.status).toBe('tracking')
    expect(card('positioning')).toMatchObject({ version: 1, changeNote: '建档' })
    expect(driver.runs.map(r => r.title)).toEqual(['前哨 · Cursor 建档', '前哨 · Cursor 建档核查'])
  })
})

describe('renumberCitations', () => {
  it('drops the removed markers and closes the gaps in the numbering', () => {
    expect(renumberCitations('甲[1]乙[2]丙[3]', [2])).toBe('甲[1]乙丙[2]')
    expect(renumberCitations('甲[1][2]乙[3]丙[1]', [1])).toBe('甲[1]乙[2]丙')
    expect(renumberCitations('甲[1]乙[2]丙[3]', [1, 3])).toBe('甲乙[1]丙')
    expect(renumberCitations('甲[1]乙[2]', [])).toBe('甲[1]乙[2]')
    expect(renumberCitations('第[9]第[10]第[11]', [9])).toBe('第第[9]第[10]')
  })
})

describe('withoutSources', () => {
  it('drops the sources, renumbers the body and keeps the 推论 marks on the same words', () => {
    const ids = Array.from({ length: 11 }, (_, i) => `s${i + 1}`)
    const body = '一[1]。推论甲[10]。二[2]，推论乙[11]。'
    const mark = (text: string) => { const start = body.indexOf(text); return { start, end: start + text.length } }
    const out = withoutSources({ body, sourceIds: ids, inferenceSpans: [mark('推论甲[10]'), mark('推论乙[11]。')] }, [1, 2])
    expect(out.body).toBe('一。推论甲[8]。二，推论乙[9]。')
    expect(out.sourceIds).toEqual(ids.slice(2))
    expect(spanText(out.body, out.inferenceSpans)).toEqual(['推论甲[8]', '推论乙[9]。'])
  })

  it('keeps a mark that begins or ends inside a marker on the marker, and drops one that covered only a removed marker', () => {
    const body = '甲[1]乙[2]丙'
    const out = withoutSources({ body, sourceIds: ['a', 'b'], inferenceSpans: [{ start: 2, end: 6 }, { start: 4, end: 7 }] }, [2])
    // [2, 6) was "1]乙[": it began inside [1], so it takes all of it, and ended inside the removed [2]; [4, 7) was "乙[2", of which 乙 stays.
    expect(out.body).toBe('甲[1]乙丙')
    expect(spanText(out.body, out.inferenceSpans)).toEqual(['[1]乙', '乙'])
    const gone = withoutSources({ body, sourceIds: ['a', 'b'], inferenceSpans: [{ start: 5, end: 8 }] }, [2])
    expect(gone.inferenceSpans).toEqual([])
  })
})
