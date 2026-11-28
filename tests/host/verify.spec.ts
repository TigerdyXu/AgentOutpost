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
import { VerifyNotRun, renumberCitations, verifyProduct, withoutVoidClaims } from '../../src/host/jobs/verify.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, completed, failure, instantClock, type Play, type Round } from '../fixtures/fake-driver.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const START = new Date(2026, 10, 25, 9, 0, 0) // local wall clock: 2026-11-25 09:00
const TODAY = '2026-11-25'
const DAY_3 = '2026-11-28'
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
  settings = { maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, model: null, verifyModel: null, briefModel: null, followupModel: null, billingFor: () => 'metered', pricesOf: () => ({ inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }) }
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
  syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null, officialConfirmed: null, ...over,
})
const official = (url: string) => addSource(url, { kind: 'official', isOfficial: true, publisher: 'Cursor' })
const addFinding = (sources: Source[], over: Partial<Omit<Finding, 'id' | 'createdAt' | 'sourceIds'>> = {}): Finding => repo.addFinding({
  productId: 'p1', runId: dailyRun().id, headline: 'Cursor 推出团队定价', why: '团队版每人每月 40 美元', importance: 'major', claimKind: 'self',
  sourceIds: sources.map(s => s.id), status: 'pending', statusNote: null, unconfirmedUntil: null, dimensions: ['business'], inference: false,
  read: false, late: false, dedupeKey: `key-${sources[0]?.url}`, verifiedOn: null, ...over,
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

interface PendingSource { sourceId: string; url: string; quote: string; needsCheck: boolean }
interface PendingItem { itemId: string; claimKind: string | null; claim: string; sources: PendingSource[] }
interface Pending { pendingFindings: PendingItem[]; pendingCardEdits: PendingItem[]; unconfirmedFindings: PendingItem[] }
interface Check { openedVia: OpenedVia; quoteFound: boolean | null; supportsClaim?: boolean | null; official?: boolean | null; syndicationGroup?: string | null }

const readPending = async (r: Round) => await r.call('outpost_read_pending') as Pending
const everySource = (p: Pending) => [...p.pendingFindings, ...p.pendingCardEdits, ...p.unconfirmedFindings].flatMap(i => i.sources)
/**
 * A check session that reports `check` (or what it gives for the source; null: says nothing) for every source waiting,
 * then ends. Unless the check says otherwise, it agrees with the researcher on whether the maker published the page.
 */
const reportCheck = (check: Check | ((s: PendingSource) => Check | null)): Play => async r => {
  for (const s of everySource(await readPending(r))) {
    const report = typeof check === 'function' ? check(s) : check
    const official = repo.getSources([s.sourceId])[0]!.isOfficial
    if (report) await r.call('outpost_report_check', { sourceId: s.sourceId, supportsClaim: null, official, ...report })
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
    await verifyProduct(deps, 'p1', 'daily', TODAY)
    expect(finding(f.id)).toMatchObject({ status: 'unconfirmed', statusNote: '只有一个来源', verifiedOn: null })
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
      await r.call('outpost_report_check', { sourceId: added.sourceId, official: false, ...SEEN })
      await r.done()
      return completed()
    }
    await verifyProduct(deps, 'p1', 'daily', DAY_3)

    expect(offered!.unconfirmedFindings.map(i => i.itemId)).toEqual([f.id])
    expect(finding(f.id)).toMatchObject({ status: 'verified', statusNote: '已证实', unconfirmedUntil: null, verifiedOn: DAY_3 })
    // It shows in the brief of the day it was confirmed, and still belongs to the day it was found.
    expect(repo.findingsVerifiedOn(DAY_3).map(x => x.id)).toEqual([f.id])
    expect(repo.findingsOfDate(TODAY).map(x => x.id)).toEqual([f.id])
    expect(repo.findingsOfDate(DAY_3)).toEqual([])
    expect(finding(f.id).createdAt).toBe(f.createdAt)
    expect(finding(f.id).sourceIds).toHaveLength(2)
    expect(repo.pendingCardEdits('p1')).toEqual([])
    expect(card('business')).toMatchObject({ version: 1, findingIds: [f.id], sourceIds: edit.sourceIds }) // 转正：写进档案
  })

  it('records the day a finding is verified: the day being processed, and only when it is verified', async () => {
    const official1 = addFinding([official('https://cursor.com/changelog/2-0')])
    const thirdParty = addFinding([addSource('https://news.example/one-report')], { claimKind: 'third-party', dedupeKey: 'k2' })
    const refuted = addFinding([official('https://cursor.com/changelog/2-1')], { dedupeKey: 'k3' })
    driver.script[VERIFY] = reportCheck(s => s.url.endsWith('2-1') ? NOT_THERE : SEEN)

    await verifyProduct(deps, 'p1', 'daily', '2026-11-24') // a run for the 24th, finishing on the clock's 25th

    expect(finding(official1.id)).toMatchObject({ status: 'verified', verifiedOn: '2026-11-24' })
    expect(finding(thirdParty.id)).toMatchObject({ status: 'unconfirmed', verifiedOn: null })
    expect(finding(refuted.id)).toMatchObject({ status: 'withdrawn', verifiedOn: null })
    expect(repo.findingsVerifiedOn('2026-11-24').map(f => f.id)).toEqual([official1.id])
  })

  it('takes one official page for a claim about the product itself only when the check agrees the maker published it (M1.6)', async () => {
    const agreed = addFinding([official('https://cursor.com/changelog/2-0')])
    // The researcher once called another company's site, and a regulator's, the maker's own.
    const refused = addFinding([official('https://cursor.example/blog/teams')], { dedupeKey: 'k2' })
    const unsure = addFinding([official('https://regulator.example/notice')], { dedupeKey: 'k3' })
    driver.script[VERIFY] = reportCheck(s => ({ ...SEEN, official: s.url.startsWith('https://cursor.com/') ? true : s.url.includes('cursor.example') ? false : null }))

    await verifyProduct(deps, 'p1', 'daily')

    expect(finding(agreed.id)).toMatchObject({ status: 'verified', statusNote: null })
    expect(finding(refused.id)).toMatchObject({ status: 'unconfirmed', statusNote: '只有一个来源' }) // waits for a second source
    expect(finding(unsure.id)).toMatchObject({ status: 'unconfirmed', statusNote: '只有一个来源' })
    expect(repo.getSources(finding(refused.id).sourceIds)[0]).toMatchObject({ isOfficial: true, officialConfirmed: false })
  })

  it('goes by the checker, not the researcher, on who published a page (M1.6)', async () => {
    // The researcher did not call the maker's own page official; the checker, having opened it, says it is.
    const blog = addSource('https://cursor.com/blog/teams', { kind: 'media', isOfficial: false, publisher: 'Cursor' })
    const f = addFinding([blog])
    driver.script[VERIFY] = reportCheck({ ...SEEN, official: true })

    await verifyProduct(deps, 'p1', 'daily')

    expect(finding(f.id)).toMatchObject({ status: 'verified', statusNote: null })
  })

  it('does not count a page checked before M1.6 as official on the researcher’s word alone', async () => {
    // Checked by an earlier build: the quote matched, nobody asked who published it.
    const old = addSource('https://cursor.com/changelog/1-9', { kind: 'official', isOfficial: true, openedVia: 'http', quoteFound: true, supportsClaim: true })
    const f = addFinding([old], { status: 'unconfirmed', unconfirmedUntil: daysAfterStart(UNCONFIRMED_WINDOW_DAYS).toISOString() })
    let offered: PendingSource[] = []
    driver.script[VERIFY] = async r => { offered = everySource(await readPending(r)); return await reportCheck(s => s.needsCheck ? SEEN : null)(r) }

    await verifyProduct(deps, 'p1', 'daily')

    expect(offered.map(s => s.needsCheck)).toEqual([false]) // its quote is settled: the page is not opened again
    expect(finding(f.id)).toMatchObject({ status: 'unconfirmed', statusNote: '只有一个来源' })
  })

  it('records today as the verified day of a baseline check', async () => {
    const f = addFinding([official('https://cursor.com/changelog/2-0')])
    driver.script[VERIFY] = reportCheck(SEEN)
    await verifyProduct(deps, 'p1', 'baseline')
    expect(finding(f.id).verifiedOn).toBe(TODAY)
  })

  it('never overwrites a verified day already recorded', async () => {
    const f = addFinding([official('https://cursor.com/changelog/2-0')], { status: 'unconfirmed', verifiedOn: '2026-11-20' })
    driver.script[VERIFY] = reportCheck(SEEN)
    await verifyProduct(deps, 'p1', 'daily', DAY_3)
    expect(finding(f.id)).toMatchObject({ status: 'verified', verifiedOn: '2026-11-20' })
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

  it('drops the sentence of a void source and renumbers the citations left in a baseline card', async () => {
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
      // The claim the review page does not back goes with its citation: no unsourced sentence is left behind.
      version: 1, body: 'Cursor 是基于 VS Code 的编辑器[1]。估计它会继续走企业路线[2]。',
      sourceIds: [sources[0]!.id, sources[2]!.id], addedSpans: [], changeNote: '建档', findingIds: [],
    })
    expect(spanText(v1.body, v1.inferenceSpans)).toEqual(['估计它会继续走企业路线[2]']) // the 推论 mark still covers the same words
    expect(repo.pendingCardEdits('p1')).toEqual([])
    expect(repo.cardHistory('p1', 'positioning')).toHaveLength(1)
    expect(edit.sourceIds).toHaveLength(3) // the edit itself is kept as it was handed in
  })

  it('keeps a sentence that still has a valid source beside the void one, and drops one that has none', async () => {
    const f = addFinding([official('https://cursor.com/changelog/2-0')])
    const sources = [official('https://cursor.com/changelog/2-0'), addSource('https://blog.example/guess')]
    addEdit({ body: '团队版每人每月 40 美元[1][2]。据说下个月还会降价[2]。', sourceIds: sources.map(s => s.id), findingIds: [f.id] })
    driver.script[VERIFY] = reportCheck(s => s.sourceId === sources[1]!.id ? NOT_THERE : SEEN)

    await verifyProduct(deps, 'p1', 'daily')

    expect(card('business')).toMatchObject({ version: 1, body: '团队版每人每月 40 美元[1]。', sourceIds: [sources[0]!.id], bullets: ['团队版 40 美元'] })
  })

  it('drops a bullet that repeats a dropped sentence, keeping the others', async () => {
    const sources = [official('https://cursor.com/'), addSource('https://blog.example/review')]
    addEdit({
      dimension: 'positioning', summary: '面向专业开发者的 AI 编辑器', bullets: ['基于 VS Code', '评测说它比同类快一倍'], changeNote: '建档',
      body: 'Cursor 是基于 VS Code 的编辑器[1]。有评测说它比同类快一倍[2]。', sourceIds: sources.map(s => s.id),
    })
    driver.script[VERIFY] = reportCheck(s => s.sourceId === sources[1]!.id ? NOT_THERE : SEEN)

    await verifyProduct(deps, 'p1', 'baseline')

    expect(card('positioning')).toMatchObject({ version: 1, body: 'Cursor 是基于 VS Code 的编辑器[1]。', bullets: ['基于 VS Code'], summary: '面向专业开发者的 AI 编辑器', sourceIds: [sources[0]!.id] })
  })

  it('rejects an edit whose every bullet, or whose summary, repeats a dropped sentence: the dimension keeps what it had', async () => {
    time.set(daysAfterStart(-10))
    repo.addCardVersion({ productId: 'p1', dimension: 'business', version: 1, summary: '个人版免费', bullets: ['个人版免费'], body: '个人版免费[1]。', sourceIds: [official('https://cursor.com/pricing').id], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: time.clock.now().toISOString() })
    time.set(START)
    const f = addFinding([official('https://cursor.com/changelog/2-0')])
    const pricing = official('https://cursor.com/pricing')
    const rumor = addSource('https://blog.example/price-cut')
    addEdit({ body: '个人版免费[1]。团队版下月降到每人 20 美元[2]。', summary: '个人免费，团队版将降价', bullets: ['团队版下月降到每人 20 美元'], sourceIds: [pricing.id, rumor.id], findingIds: [f.id] })
    const reviewed = addSource('https://blog.example/review')
    addEdit({
      dimension: 'positioning', summary: '评测说它比同类快一倍', bullets: ['基于 VS Code'], changeNote: '建档',
      body: 'Cursor 是基于 VS Code 的编辑器[1]。有评测说它比同类快一倍[2]。', sourceIds: [official('https://cursor.com/').id, reviewed.id],
    })
    driver.script[VERIFY] = reportCheck(s => s.sourceId === rumor.id || s.sourceId === reviewed.id ? NOT_THERE : SEEN)

    await verifyProduct(deps, 'p1', 'daily')

    expect(finding(f.id).status).toBe('verified')
    expect(repo.cardHistory('p1', 'business').map(c => c.version)).toEqual([1]) // its only point was the refuted claim
    expect(card('positioning')).toBeUndefined() // its summary was: 「暂无可核实的信息」
    expect(repo.pendingCardEdits('p1')).toEqual([])
  })

  it('does not take the product\'s own name or company in a summary for a repeat of a dropped sentence', async () => {
    repo.upsertProduct({ ...repo.getProduct('p1')!, name: 'Kimi', company: '北京月之暗面科技有限公司' })
    const sources = [official('https://kimi.example/'), addSource('https://blog.example/ipo')]
    addEdit({
      dimension: 'positioning', summary: '北京月之暗面科技有限公司的长文本助手', bullets: ['长文本助手'], changeNote: '建档',
      body: 'Kimi 是长文本助手[1]。北京月之暗面科技有限公司据说要上市[2]。', sourceIds: sources.map(s => s.id),
    })
    driver.script[VERIFY] = reportCheck(s => s.sourceId === sources[1]!.id ? NOT_THERE : SEEN)

    await verifyProduct(deps, 'p1', 'baseline')

    expect(card('positioning')).toMatchObject({ version: 1, summary: '北京月之暗面科技有限公司的长文本助手', body: 'Kimi 是长文本助手[1]。' })
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
    driver.script[VERIFY] = reportCheck(UNOPENED)

    await verifyProduct(deps, 'p1', 'daily') // within 7 days: waits for the next check with a session
    expect(driver.runs).toHaveLength(1)

    time.set(daysAfterStart(UNCONFIRMED_WINDOW_DAYS + 1))
    await verifyProduct(deps, 'p1', 'daily') // only an expired one left: settled without the agent
    expect(driver.runs).toHaveLength(1)
    expect(finding(old.id).status).toBe('unproven')
    expect(repo.runsOfDate(localDate(daysAfterStart(UNCONFIRMED_WINDOW_DAYS + 1)), 'verify')).toEqual([])
  })

  it('does not judge a check that stopped without outpost_done, and the next check reuses what it reported', async () => {
    const sources = [official('https://cursor.com/'), addSource('https://news.example/cursor-review')]
    const edit = addEdit({ dimension: 'positioning', body: 'Cursor 是 AI 编辑器[1]，评测说它很快[2]。', sourceIds: sources.map(s => s.id), changeNote: '建档' })
    // The checker reports the first source, then runs out (no outpost_done, not even after the reminder).
    driver.script[VERIFY] = async r => {
      if (r.kind === 'run') await r.call('outpost_report_check', { sourceId: sources[0]!.id, official: sources[0]!.isOfficial, ...SEEN })
      return completed()
    }

    const error = await verifyProduct(deps, 'p1', 'baseline').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(VerifyNotRun)
    expect((error as VerifyNotRun).message).toBe('会话没有调用 outpost_done 就停了，这次不下结论')
    expect(repo.runsOfDate(TODAY, 'verify')[0]).toMatchObject({ status: 'failed', error: '会话没有调用 outpost_done 就停了，这次不下结论' })
    expect(driver.nudges).toHaveLength(1) // it was reminded once
    expect(repo.pendingCardEdits('p1').map(e => e.id)).toEqual([edit.id]) // not rejected for the source it never reached
    expect(card('positioning')).toBeUndefined()
    expect(repo.getSources([sources[0]!.id])[0]).toMatchObject({ openedVia: 'http', quoteFound: true }) // the report it made is kept

    // The next check is told the first source is done, reports only the other one, and finishes: the card is written.
    let offered: PendingSource[] = []
    driver.script[VERIFY] = async r => {
      offered = everySource(await readPending(r))
      for (const s of offered.filter(s => s.needsCheck)) await r.call('outpost_report_check', { sourceId: s.sourceId, official: null, ...SEEN })
      await r.done()
      return completed()
    }
    await verifyProduct(deps, 'p1', 'baseline')
    expect(offered.map(s => [s.sourceId, s.needsCheck])).toEqual([[sources[0]!.id, false], [sources[1]!.id, true]])
    expect(card('positioning')).toMatchObject({ version: 1, sourceIds: sources.map(s => s.id) })
  })

  it('rejects a daily card edit with no valid source left, as a baseline card would be', async () => {
    const f = addFinding([official('https://cursor.com/changelog/2-0')])
    const misquoted = addSource('https://blog.example/misquote')
    addEdit({ dimension: 'business', body: '团队版 40 美元[1]。', sourceIds: [misquoted.id], findingIds: [f.id] })
    const unseen = addSource('https://mp.weixin.qq.com/s?__biz=MzC&mid=2&idx=1&sn=y')
    addEdit({ dimension: 'technology', body: '后台 Agent 上线[1]。', sourceIds: [unseen.id], findingIds: [f.id] })
    const fine = official('https://cursor.com/changelog/2-0')
    addEdit({ dimension: 'experience', body: '上手更快[1]。', sourceIds: [fine.id], findingIds: [f.id] })
    driver.script[VERIFY] = reportCheck(s => s.sourceId === misquoted.id ? NOT_THERE : s.sourceId === unseen.id ? UNOPENED : SEEN)

    await verifyProduct(deps, 'p1', 'daily')

    expect(finding(f.id).status).toBe('verified')
    expect(card('business')).toBeUndefined() // its only source does not hold the quote
    expect(card('technology')).toBeUndefined() // nobody could see its only source
    expect(card('experience')).toMatchObject({ version: 1, sourceIds: [fine.id] })
    expect(repo.pendingCardEdits('p1')).toEqual([])
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
      for (const s of everySource(await readPending(r))) await r.call('outpost_report_check', { sourceId: s.sourceId, official: null, ...SEEN })
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

describe('verifyProduct inside the baseline', () => {
  it('keeps a product in baseline when its check stopped part-way', async () => {
    repo.setProductStatus('p1', 'candidate')
    driver.script['outpost-baseline-'] = async r => {
      await r.call('outpost_submit_card', {
        dimension: 'positioning', summary: '面向专业开发者的 AI 编辑器', bullets: ['基于 VS Code'], body: 'Cursor 是基于 VS Code 的编辑器[1]。',
        sources: [{ url: 'https://cursor.com/', title: 'Cursor 官网', publisher: 'Cursor', publishedAt: null, kind: 'official', isOfficial: true, quote: 'The AI Code Editor' }],
      })
      await r.done()
      return completed()
    }
    driver.script[VERIFY] = () => completed() // runs out of room before reporting anything

    startBaseline({ ...deps, verifyProduct: (id, scope) => verifyProduct(deps, id, scope) }, ['p1'])
    await runner.idle()

    expect(repo.getProduct('p1')!.status).toBe('baselining') // not tracked with an empty dossier
    expect(repo.runsOfDate(TODAY, 'baseline')[0]).toMatchObject({ status: 'failed', error: '核查没有完成：会话没有调用 outpost_done 就停了，这次不下结论' })
    expect(repo.pendingCardEdits('p1')).toHaveLength(1) // the card waits for a check that finishes
    expect(card('positioning')).toBeUndefined()
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

describe('withoutVoidClaims', () => {
  const text = (body: string, inferenceSpans: Span[] = []) => ({ summary: '总结', bullets: ['要点'], body, sourceIds: Array.from({ length: 11 }, (_, i) => `s${i + 1}`), inferenceSpans })
  const all = (except: number[]) => Array.from({ length: 11 }, (_, i) => i + 1).filter(n => !except.includes(n))

  it('drops the sentences resting only on void sources, renumbers the rest and keeps the 推论 marks on the same words', () => {
    const body = '一[1]。推论甲[10]。二[2]，推论乙[11]。'
    const mark = (part: string) => { const start = body.indexOf(part); return { start, end: start + part.length } }
    const out = withoutVoidClaims(text(body, [mark('推论甲[10]'), mark('推论乙[11]。')]), [1, 2], all([1, 2]))!
    expect(out.body).toBe('推论甲[8]。二，推论乙[9]。') // 一 rested on [1] alone; 二 keeps [11] beside the void [2]
    expect(out.sourceIds).toEqual(text(body).sourceIds.slice(2))
    expect(spanText(out.body, out.inferenceSpans)).toEqual(['推论甲[8]', '推论乙[9]。'])
  })

  it('splits sentences on 。！？； and line breaks, a citation written after the mark staying with its sentence', () => {
    const body = '甲是编辑器[1]！乙说它快。[2]\n\n丙会涨价[3]；丁[1]？\n- 戊[2]\n己[1]。'
    const out = withoutVoidClaims({ ...text(body), sourceIds: ['a', 'b', 'c'] }, [2], [1])!
    // 乙 and 戊 rest on the void [2]; 丙 rests on [3], which was never seen (not valid, not void) and stays.
    expect(out.body).toBe('甲是编辑器[1]！\n\n丙会涨价[2]；丁[1]？\n己[1]。')
    expect(out.sourceIds).toEqual(['a', 'c'])
  })

  it('drops a sentence whose other source was never seen, and that source with it when it is cited nowhere else', () => {
    const out = withoutVoidClaims({ ...text('甲[1]。乙[2][3]。丙[4]。'), sourceIds: ['a', 'b', 'c', 'd'] }, [2], [1, 4])!
    expect(out.body).toBe('甲[1]。丙[2]。')
    expect(out.sourceIds).toEqual(['a', 'd'])
  })

  it('moves a mark that began in a dropped sentence to where the text after it starts, and drops one inside it', () => {
    const body = '甲[1]。乙[2]。丙[1]。'
    const out = withoutVoidClaims({ ...text(body), sourceIds: ['a', 'b'], inferenceSpans: [{ start: 7, end: 14 }, { start: 6, end: 9 }] }, [2], [1])!
    // [7, 14) was 「2]。丙[1]」: it began inside the dropped 「乙[2]。」, so it now starts where 丙 does. [6, 9) was 「[2]」, inside it: gone.
    expect(out.body).toBe('甲[1]。丙[1]。')
    expect(spanText(out.body, out.inferenceSpans)).toEqual(['丙[1]'])
  })

  it('keeps a mark that begins or ends inside a marker on the marker, and drops one that covered only a removed marker', () => {
    const body = '甲[1]乙[2]丙'
    const out = withoutVoidClaims({ ...text(body), sourceIds: ['a', 'b'], inferenceSpans: [{ start: 2, end: 6 }, { start: 4, end: 7 }] }, [2], [1])!
    // One sentence, still backed by [1]: only the marker [2] goes. [2, 6) was "1]乙[": it began inside [1], so it takes all
    // of it, and ended inside the removed [2]; [4, 7) was "乙[2", of which 乙 stays.
    expect(out.body).toBe('甲[1]乙丙')
    expect(spanText(out.body, out.inferenceSpans)).toEqual(['[1]乙', '乙'])
    const gone = withoutVoidClaims({ ...text(body), sourceIds: ['a', 'b'], inferenceSpans: [{ start: 5, end: 8 }] }, [2], [1])!
    expect(gone.inferenceSpans).toEqual([])
  })

  it('drops a bullet sharing 8 or more characters with a dropped sentence, ignoring width, spaces and punctuation', () => {
    const card = { summary: 'AI 编辑器', bullets: ['基于 VS Code', '比同类快一倍，评测说', '说它比同类　快一倍！'], body: '基于 VS Code[1]。有评测说它比同类快一倍[2]。', sourceIds: ['a', 'b'], inferenceSpans: [] }
    // 「比同类快一倍评测说」 shares only 6 characters in a row with 「有评测说它比同类快一倍」; 「说它比同类快一倍」 shares 8.
    expect(withoutVoidClaims(card, [2], [1])!.bullets).toEqual(['基于 VS Code', '比同类快一倍，评测说'])
    expect(withoutVoidClaims({ ...card, bullets: ['评测说它比同类快一倍'] }, [2], [1])).toBeNull()
    expect(withoutVoidClaims({ ...card, summary: '有评测说它比同类快一倍' }, [2], [1])).toBeNull()
    // Nothing dropped, nothing compared.
    expect(withoutVoidClaims({ ...card, bullets: ['评测说它比同类快一倍'] }, [], [1, 2])!.bullets).toEqual(['评测说它比同类快一倍'])
  })

  it('keeps a citation written after a closing quote or bracket with the sentence it closes', () => {
    const ab = (body: string) => ({ ...text(body), sourceIds: ['a', 'b'] })
    // 「…。」[2]: the quoted, refuted sentence goes whole; the sentence after it stays, renumbered.
    expect(withoutVoidClaims(ab('官方说：「速度提升一倍。」[2]团队版免费[1]。'), [2], [1])).toMatchObject({ body: '团队版免费[1]。', sourceIds: ['a'] })
    expect(withoutVoidClaims(ab('官方说：「速度提升一倍。」[1]团队版免费[2]。'), [2], [1])).toMatchObject({ body: '官方说：「速度提升一倍。」[1]', sourceIds: ['a'] })
    // Straight and curly double quotes alike, with no unbalanced quote left behind.
    for (const quoted of ['有人说："它比同类快一倍。"[2]', '有人说：“它比同类快一倍。”[2]']) {
      const out = withoutVoidClaims(ab(`团队版免费[1]。${quoted}另外它支持中文。`), [2], [1])!
      expect(out.body).toBe('团队版免费[1]。另外它支持中文。')
    }
    // A bracketed aside, closed after its stop, goes whole.
    expect(withoutVoidClaims(ab('团队版免费[1]。（据说下月降价。）[2]'), [2], [1])!.body).toBe('团队版免费[1]。')
    expect(withoutVoidClaims(ab('团队版免费[1]。(据说下月降价。)[2]【传闻。】[2]'), [2], [1])!.body).toBe('团队版免费[1]。')
    // A straight quote, double or single, opening the next sentence is not taken for the close of this one.
    expect(withoutVoidClaims(ab('团队版免费[1]。"据说下月降价。"[2]'), [2], [1])!.body).toBe('团队版免费[1]。')
    expect(withoutVoidClaims(ab("团队版免费[1]。'据说下月降价。'[2]"), [2], [1])!.body).toBe('团队版免费[1]。')
    expect(withoutVoidClaims(ab("有人说：'它比同类快一倍。'[2]团队版免费[1]。"), [2], [1])!.body).toBe('团队版免费[1]。')
  })

  it('renumbers the citations in the bullets like the body, and drops a bullet whose every citation is void', () => {
    const card = {
      summary: '个人免费，团队收费',
      bullets: ['个人版免费[1]', '团队版 40 美元[3]', '传闻会降价[2]', '两种都有[1][2]', '没有引用的要点'],
      body: '个人版免费[1]。据说下月降价[2]。团队版每人每月 40 美元[3]。',
      sourceIds: ['a', 'b', 'c'],
      inferenceSpans: [],
    }
    const out = withoutVoidClaims(card, [2], [1, 3])!
    expect(out.body).toBe('个人版免费[1]。团队版每人每月 40 美元[2]。')
    expect(out.sourceIds).toEqual(['a', 'c'])
    expect(out.bullets).toEqual(['个人版免费[1]', '团队版 40 美元[2]', '两种都有[1]', '没有引用的要点'])
    // A source not void, whose sentence went with a void one, stays while a bullet still cites it, and leaves otherwise.
    const lone = { ...card, body: '个人版免费[1]。据说下月降价[2][3]。', bullets: ['个人版免费[1]', '团队版另算[3]'] }
    expect(withoutVoidClaims(lone, [2], [1])).toMatchObject({ body: '个人版免费[1]。', sourceIds: ['a', 'c'], bullets: ['个人版免费[1]', '团队版另算[2]'] })
    expect(withoutVoidClaims({ ...lone, bullets: ['个人版免费[1]'] }, [2], [1])).toMatchObject({ body: '个人版免费[1]。', sourceIds: ['a'] })
  })

  it('drops a source cited only by bullets that went, and keeps one the summary cites', () => {
    const card = {
      summary: '个人免费', bullets: ['个人版免费[1]', '下个月团队版会降价到二十美元[3]'], body: '个人版免费[1]。据说下个月团队版会降价到二十美元[2]。',
      sourceIds: ['a', 'b', 'c'], inferenceSpans: [],
    }
    // The second bullet repeats the dropped sentence and goes; [3] was cited by it alone.
    expect(withoutVoidClaims(card, [2], [1])).toMatchObject({ bullets: ['个人版免费[1]'], sourceIds: ['a'] })
    expect(withoutVoidClaims({ ...card, summary: '个人免费，团队另算[3]' }, [2], [1])).toMatchObject({ summary: '个人免费，团队另算[2]', bullets: ['个人版免费[1]'], sourceIds: ['a', 'c'] })
    // A source cited nowhere at all stays, as before.
    expect(withoutVoidClaims({ ...card, bullets: ['个人版免费[1]'], sourceIds: ['a', 'b', 'c', 'd'] }, [2], [1])!.sourceIds).toEqual(['a', 'c', 'd'])
  })

  it('rejects the edit when every bullet rests only on void sources', () => {
    const card = { summary: '个人免费', bullets: ['传闻会降价[2]', '还会再降[2]'], body: '个人版免费[1]。据说下月降价[2]。', sourceIds: ['a', 'b'], inferenceSpans: [] }
    expect(withoutVoidClaims(card, [2], [1])).toBeNull()
  })

  it('does not count the product\'s name or company toward an echo, and counts a Latin word or number as one unit', () => {
    const names = ['Perplexity', 'Perplexity AI']
    const card = { summary: 'Perplexity 主打答案引擎', bullets: ['PERPLEXITY AI 的 Pro 版 20 美元'], body: '它主打答案引擎[1]。Perplexity 的月活过亿[2]。PerplexityAI 的 Pro 版 20 美元[2]。', sourceIds: ['a', 'b'], inferenceSpans: [] }
    expect(withoutVoidClaims(card, [2], [1], names)).toMatchObject({ summary: 'Perplexity 主打答案引擎', body: '它主打答案引擎[1]。' })
    // A Latin word or number as written is one unit (not one per letter, nor one per stretch of words): a bullet that says
    // 「支持 GPT-4o 和 Claude 3.5 Sonnet」 again word for word repeats the dropped sentence (9 units in a row) and goes.
    const models = { ...card, summary: '答案引擎', bullets: ['支持 GPT-4o 和 Claude 3.5 Sonnet', '它主打答案引擎'], body: '它主打答案引擎[1]。据说支持 GPT-4o 和 Claude 3.5 Sonnet[2]。' }
    expect(withoutVoidClaims(models, [2], [1], names)!.bullets).toEqual(['它主打答案引擎'])
    // …while a bullet sharing only a few long words with it (5 units here) does not.
    expect(withoutVoidClaims({ ...models, bullets: ['兼容 Claude 3.5 Sonnet 接口'] }, [2], [1], names)!.bullets).toEqual(['兼容 Claude 3.5 Sonnet 接口'])
    // A real echo is still one, the names left out of the count or not.
    const echo = { ...card, summary: '答案引擎', bullets: ['Perplexity 月活过亿，增速第一', '它主打答案引擎'], body: '它主打答案引擎[1]。据说 Perplexity 月活过亿，增速第一[2]。' }
    expect(withoutVoidClaims(echo, [2], [1], names)!.bullets).toEqual(['它主打答案引擎'])
    expect(withoutVoidClaims({ ...echo, summary: 'Perplexity 月活过亿，增速第一' }, [2], [1], names)).toBeNull()
    expect(withoutVoidClaims({ ...echo, bullets: ['豆包月活过亿，增速是同类第一', '它主打答案引擎'], body: '它主打答案引擎[1]。据说字节跳动的豆包月活过亿，增速是同类第一[2]。' }, [2], [1], ['豆包', '字节跳动'])!.bullets)
      .toEqual(['它主打答案引擎'])
  })
})
