// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { judge } from '../../src/core/credibility.ts'
import type { Dimension, Finding, Product, Source } from '../../src/core/types.ts'
import type { BriefView } from '../../src/host/api.ts'
import { VERIFY_BUDGET_NOTE } from '../../src/host/jobs/daily.ts'
import { PROMOTED_NOTE } from '../../src/host/jobs/verify.ts'
import { Today } from '../../src/client/pages/Today.tsx'
import { App } from '../../src/client/shell/App.tsx'
import { SessionNavigationError } from '../../src/client/navigation.ts'
import { PROMOTED, UNOPENED, VERIFY_BUDGET } from '../../src/client/notes.ts'
import type { Shell } from '../../src/client/shell/context.ts'
import { all, brief, briefView, click, fail, finding, mount, product, settle, source, state, stubApi, t, tEn, text, track, tracked, unmount } from '../fixtures/client.tsx'

// ---- a day to read: five products in two tracks ----

const doubao = product('p1', '豆包·小豆'), muse = product('p2', 'Meta Muse'), dots = product('p3', 'OpenAI Dots')
const lingguang = product('p4', '蚂蚁灵光'), grok = product('p5', 'Grok Bots'), rayban = product('p6', 'Ray-Ban Meta')
const everyone: Product[] = [doubao, muse, dots, lingguang, grok, rayban]
const DIMENSIONS: Dimension[] = [{ key: 'positioning', label: '定位' }, { key: 'monetization', label: '商业化' }]
const shellState = state({
  tracks: [
    track('t1', 'Personal Agent', [doubao, muse, dots, lingguang, grok].map(p => tracked(p)), { dimensions: DIMENSIONS }),
    track('t2', 'AI 眼镜', [tracked(rayban)], { dimensions: [{ key: 'optics', label: '光学' }] }),
  ],
})

/** The brief's main findings in the order the brief lists them, then its minor ones. */
const view = (main: Finding[], extra: Partial<BriefView> & { minor?: Finding[]; briefExtra?: Parameters<typeof brief>[0] } = {}): BriefView => {
  const { minor = [], briefExtra = {}, ...rest } = extra
  const findings = [...main, ...minor]
  return briefView({
    brief: brief({ gist: '今天的主线是从内测走向全量。', findingIds: main.map(f => f.id), minorIds: minor.map(f => f.id), ...briefExtra }),
    findings, products: everyone, sources: [], ...rest,
  })
}

/** Today's page over a stubbed API; the observer of cards and the answers to what the page sends are set here. */
async function show(answer: BriefView | ReturnType<typeof fail>, shell: Partial<Shell> = {}, extra: Record<string, unknown> = {}) {
  const api = stubApi({
    'GET brief': answer, 'POST findings/:id/read': { ok: true }, 'POST brief/read-all': { ok: true }, 'POST followup': { sessionId: 's-1' }, ...extra,
  })
  const context = await mount(<Today />, { state: shellState, ...shell })
  return { api, context }
}

const cards = () => all('.op-card:not([data-minor])')
const headlines = () => all('.op-card-title').map(title => title.textContent)
const cardOf = (headline: string) => all('.op-card').find(card => card.querySelector('.op-card-title')?.textContent === headline)!
/** A button or link inside one card. */
const inside = (card: Element, name: string) => [...card.querySelectorAll<HTMLElement>('button, a')].find(control => control.textContent?.trim() === name)
const tags = (scope: ParentNode, kind: string) => [...scope.querySelectorAll('.op-tag')].filter(tag => tag.getAttribute('data-kind') === kind)
const title = () => document.querySelector('.op-today h1')?.textContent
const meta = () => document.querySelector('.op-day-meta')?.textContent
const notes = () => all('.op-day-note').map(note => note.textContent)

// ---- a stand-in for the browser's IntersectionObserver ----

class FakeObserver {
  static all: FakeObserver[] = []
  readonly targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback) { FakeObserver.all.push(this) }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  takeRecords() { return [] }
}
/** Tells the observer watching `card` that it is, or is not, in the viewport now (not awaiting what the page then does). */
function report(card: Element, isIntersecting: boolean) {
  const observer = FakeObserver.all.find(candidate => candidate.targets.has(card))
  if (!observer) throw new Error('No observer is watching that card')
  observer.callback([{ target: card, isIntersecting } as unknown as IntersectionObserverEntry], observer as unknown as IntersectionObserver)
}
async function inView(card: Element, isIntersecting: boolean) {
  await act(async () => { report(card, isIntersecting) })
  await settle()
}

beforeEach(() => { FakeObserver.all = []; vi.stubGlobal('IntersectionObserver', FakeObserver) })
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); FakeObserver.all = [] })

describe('the day', () => {
  it('orders cards as the brief says and folds minor updates', async () => {
    const [a, b, c] = [finding('f1', 'p1', { importance: 'notable' }), finding('f2', 'p2'), finding('f3', 'p3')]
    const minor = [finding('m1', 'p4', { importance: 'minor', headline: '设置页文案调整' }), finding('m2', 'p5', { importance: 'minor', headline: '修了一个崩溃' })]
    // The brief's order, not the order of the findings list, nor importance alone, decides.
    await show({ ...view([b, a, c], { minor }), findings: [a, b, c, ...minor] })
    expect(headlines()).toEqual(['标题 f2', '标题 f1', '标题 f3'])
    expect(cardOf('标题 f2').textContent).toContain('Meta Muse')
    expect(cardOf('标题 f2').textContent).toContain('Personal Agent')
    expect(cardOf('标题 f2').textContent).toContain('为什么值得注意：原因 f2')
    // The level of each, in words.
    expect(tags(cardOf('标题 f2'), 'major')[0]?.textContent).toBe('重要')
    expect(tags(cardOf('标题 f1'), 'notable')[0]?.textContent).toBe('值得留意')
    // The summary is the AI's own, so it is marked as such.
    expect(document.querySelector('.op-gist')?.textContent).toContain('今天的主线是从内测走向全量。')
    expect(tags(document.querySelector('.op-gist')!, 'ai')[0]?.textContent).toBe('AI 归纳')

    // The minor ones are one folded row until it is opened, and fold away again.
    expect(text()).not.toContain('设置页文案调整')
    const fold = () => document.querySelector<HTMLElement>('.op-fold')!
    expect(fold().textContent).toContain('另有 2 条小更新，点开看')
    expect(fold().getAttribute('aria-expanded')).toBe('false')
    await click(fold())
    expect(all('.op-card[data-minor]').map(card => card.querySelector('.op-card-title')?.textContent)).toEqual(['设置页文案调整', '修了一个崩溃'])
    expect(fold().textContent).toContain('收起 ↑')
    expect(fold().getAttribute('aria-expanded')).toBe('true')
    await click(fold())
    expect(text()).not.toContain('设置页文案调整')
    expect(cards()).toHaveLength(3)
  })

  it('shows the date, when it finished, and how much there is to read', async () => {
    const f = [finding('f1', 'p1', { sourceIds: ['s1'] }), finding('f2', 'p2')]
    await show({ ...view(f), sources: [source('s1')] })
    expect(title()).toBe('11月25日 · 周三')
    // 08:12 on the reader's clock, the products the brief names, the findings worth reading, all of them checked.
    expect(meta()).toBe('08:12 跑完 · 6 个产品 · 2 条值得看 · 每条都过了核查')
    unmount()
    // An unconfirmed one is not "checked": the line counts it instead.
    await show(view([finding('f1', 'p1'), finding('f2', 'p2', { status: 'unconfirmed', statusNote: '只有一个来源' })]))
    expect(meta()).toBe('08:12 跑完 · 6 个产品 · 2 条值得看 · 1 条待确认')
  })

  it('writes the weekday of the day itself', async () => {
    await show(view([finding('f1', 'p1')], { briefExtra: { date: '2025-11-25' } }), { route: { page: 'today', date: '2025-11-25' } })
    expect(title()).toBe('11月25日 · 周二')
    unmount()
    await show(view([finding('f1', 'p1')], { briefExtra: { date: '2026-11-22' } }), { route: { page: 'today', date: '2026-11-22' } })
    expect(title()).toBe('11月22日 · 周日')
  })

  it('goes back to the day before, and back to today from an earlier day', async () => {
    const { api, context } = await show({ ...view([finding('f1', 'p1')]), prevDate: '2026-11-24' })
    expect(api.requests.find(r => r.path === 'brief')!.query).toEqual({})
    expect(all('.op-day-nav button').map(button => button.textContent)).toEqual(['‹ 昨天', '全部已读'])
    await click('‹ 昨天')
    expect(context.navigate).toHaveBeenCalledWith({ page: 'today', date: '2026-11-24' })
    unmount()

    // On an earlier day the page asks for that day, and offers the way back.
    const past = await show({ ...view([finding('f1', 'p1')], { briefExtra: { date: '2026-11-24' } }), prevDate: '2026-11-21' }, { route: { page: 'today', date: '2026-11-24' } })
    expect(past.api.requests.find(r => r.path === 'brief')!.query).toEqual({ date: '2026-11-24' })
    expect(title()).toBe('11月24日 · 周二')
    expect(all('.op-day-nav button').map(button => button.textContent)).toEqual(['今天 ›', '‹ 昨天', '全部已读'])
    await click('今天 ›')
    expect(past.context.navigate).toHaveBeenCalledWith({ page: 'today' })
    await click('‹ 昨天')
    expect(past.context.navigate).toHaveBeenCalledWith({ page: 'today', date: '2026-11-21' })
  })

  it('disables ‹ 昨天 when there is no earlier brief', async () => {
    await show(view([finding('f1', 'p1')]))
    expect(document.querySelector<HTMLButtonElement>('.op-day-nav button')!.disabled).toBe(true)
  })

  it('filters by track with the counts in the pills', async () => {
    await show(view([finding('f1', 'p1'), finding('f2', 'p6'), finding('f3', 'p2')]))
    const pills = () => all('.op-filter button')
    expect(pills().map(pill => pill.textContent)).toEqual(['全部 3', 'Personal Agent 2', 'AI 眼镜 1'])
    expect(pills().map(pill => pill.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false'])
    await click(pills()[2]!)
    expect(headlines()).toEqual(['标题 f2'])
    expect(pills()[2]!.getAttribute('aria-pressed')).toBe('true')
    await click(pills()[1]!)
    expect(headlines()).toEqual(['标题 f1', '标题 f3'])
    await click(pills()[0]!)
    expect(headlines()).toEqual(['标题 f1', '标题 f2', '标题 f3'])
  })

  it('names the filtered track on a card of a product in two tracks', async () => {
    // 小豆 is in 「Personal Agent」 (its first track) and 「手机 AI 助理」.
    const phone = track('t3', '手机 AI 助理', [tracked(doubao)])
    await show(view([finding('f1', 'p1')]), { state: { ...shellState, tracks: [...shellState.tracks, phone] } })
    const pill = (name: string) => all('.op-filter button').find(button => button.textContent?.startsWith(name))!
    await click(pill('手机 AI 助理'))
    expect(cardOf('标题 f1').textContent).toContain('· 手机 AI 助理')
    expect(cardOf('标题 f1').textContent).not.toContain('Personal Agent')
    await click(pill('Personal Agent'))
    expect(cardOf('标题 f1').textContent).toContain('· Personal Agent')
    expect(cardOf('标题 f1').textContent).not.toContain('手机 AI 助理')
  })

  it('names every track of the product when the brief is not filtered', async () => {
    const phone = track('t3', '手机 AI 助理', [tracked(doubao)])
    await show(view([finding('f1', 'p1')]), { state: { ...shellState, tracks: [...shellState.tracks, phone] } })
    // In the track list's order.
    expect(cardOf('标题 f1').querySelector('.op-card-track')?.textContent).toBe('· Personal Agent、手机 AI 助理')
  })

  it('leaves a track with no products out of the pills', async () => {
    const picking = track('t3', 'AI 编程助手', [], { status: 'picking' })
    await show(view([finding('f1', 'p1')]), { state: { ...shellState, tracks: [...shellState.tracks, picking] } })
    expect(all('.op-filter button').map(pill => pill.textContent)).toEqual(['全部 1', 'Personal Agent 1', 'AI 眼镜 0'])
  })

  it('leaves the 为什么值得注意 label out when a finding has no reason', async () => {
    await show(view([finding('f1', 'p1', { why: '' }), finding('f2', 'p2')]))
    expect(cardOf('标题 f1').querySelector('.op-card-why')).toBeNull()
    expect(cardOf('标题 f2').querySelector('.op-card-why')?.textContent).toBe('为什么值得注意：原因 f2')
  })

  it('names the dimensions a finding changed, and only for what went into the profile', async () => {
    const changed = finding('f1', 'p1', { dimensions: ['positioning', 'monetization', 'audience'] })
    const waiting = finding('f2', 'p2', { status: 'unconfirmed', statusNote: '只有一个来源', dimensions: ['positioning'] })
    // f1 names three dimensions, but only two cards took a version resting on it: the profile changed there only.
    await show(view([changed, waiting], { changed: { f1: ['positioning', 'monetization'], f2: ['positioning'] } }))
    expect(cardOf('标题 f1').querySelector('.op-card-changed')?.textContent).toBe('改了档案：定位、商业化')
    // A 「待确认」 finding is not in the profile (design §8).
    expect(cardOf('标题 f2').querySelector('.op-card-changed')).toBeNull()
    expect(inside(cardOf('标题 f2'), '看改动 →')).toBeUndefined()
  })

  it('does not name a dimension that none of the product’s tracks lists any more, nor offer 看改动 for it', async () => {
    // 定价 was a card of a track the product left: it is kept, but not on the profile, so the brief does not point there.
    const both = finding('f1', 'p1', { dimensions: ['pricing', 'monetization'] })
    const hidden = finding('f2', 'p2', { dimensions: ['pricing'] })
    const { context } = await show(view([both, hidden], { changed: { f1: ['pricing', 'monetization'], f2: ['pricing'] } }))
    expect(cardOf('标题 f1').querySelector('.op-card-changed')?.textContent).toBe('改了档案：商业化')
    await click(inside(cardOf('标题 f1'), '看改动 →')!)
    expect(context.navigate).toHaveBeenCalledWith({ page: 'product', productId: 'p1', tab: 'dossier', expand: 'monetization' })
    // Only the hidden one changed: no line, no button, and no raw key anywhere.
    expect(cardOf('标题 f2').querySelector('.op-card-changed')).toBeNull()
    expect(inside(cardOf('标题 f2'), '看改动 →')).toBeUndefined()
    expect(text()).not.toContain('pricing')
  })
})

describe('marks and notes on a card', () => {
  it('labels an unopenable source 原文打不开', async () => {
    const unopened = finding('f1', 'p1', { status: 'unconfirmed', statusNote: UNOPENED, sourceIds: ['s1', 's2'] })
    await show({ ...view([unopened]), sources: [source('s1', { openedVia: 'unopened', publisher: '某公众号', publishedAt: null }), source('s2', { isOfficial: true, publisher: '官方博客', publishedAt: null })] })
    const card = cardOf('标题 f1')
    const chips = [...card.querySelectorAll('.op-source')]
    expect(chips.map(chip => chip.textContent)).toEqual(['某公众号原文打不开', '官方博客官方'])
    expect(tags(chips[0]!, 'unopened')).toHaveLength(1)
    expect(tags(chips[1]!, 'official')).toHaveLength(1)
    // The finding waits as 待确认; the unopened mark is on the source and is not said twice.
    expect(tags(card, 'unconfirmed')).toHaveLength(1)
    expect(tags(card, 'unopened')).toHaveLength(1)
  })

  it('shows one chip per page, even when the finding lists the same page twice', async () => {
    const twice = finding('f1', 'p1', { sourceIds: ['s1', 's2', 's3'] })
    await show({ ...view([twice]), sources: [
      source('s1', { url: 'https://www.pingwest.com/a/319864', publisher: '品玩' }),
      source('s2', { url: 'https://pingwest.com/a/319864?utm_source=feed', publisher: '品玩' }),
      source('s3', { url: 'https://36kr.com/p/1', publisher: '36氪' }),
    ] })
    expect([...cardOf('标题 f1').querySelectorAll('.op-source')].map(chip => chip.textContent)).toEqual(['品玩 · 11-24', '36氪 · 11-24'])
  })

  it('says 原文打不开 on the finding when no chip does', async () => {
    await show({ ...view([finding('f1', 'p1', { status: 'unconfirmed', statusNote: UNOPENED, sourceIds: ['s1'] })]), sources: [source('s1')] })
    expect(tags(cardOf('标题 f1'), 'unconfirmed')).toHaveLength(1)
    expect(tags(cardOf('标题 f1'), 'unopened')).toHaveLength(1)
  })

  it('marks an unconfirmed finding 待确认 with its note', async () => {
    await show({ ...view([finding('f1', 'p3', { status: 'unconfirmed', statusNote: '只有一个来源', sourceIds: ['s1'] }), finding('f2', 'p1')]), sources: [source('s1')] })
    const card = cardOf('标题 f1')
    expect(tags(card, 'unconfirmed')[0]?.textContent).toBe('待确认')
    expect(card.querySelector('.op-card-status')?.textContent).toBe('待确认只有一个来源')
    expect(tags(cardOf('标题 f2'), 'unconfirmed')).toHaveLength(0)
    expect(cardOf('标题 f2').querySelector('.op-card-status')).toBeNull()
  })

  it('says 已证实 only on the day a finding was confirmed', async () => {
    const promoted = finding('f1', 'p1', { statusNote: PROMOTED, verifiedOn: '2026-11-25' })
    const earlier = finding('f2', 'p2', { statusNote: PROMOTED, verifiedOn: '2026-11-24' })
    const plain = finding('f3', 'p3', { statusNote: null, verifiedOn: '2026-11-25' })
    await show(view([promoted, earlier, plain]))
    expect(tags(cardOf('标题 f1'), 'promoted').map(tag => tag.textContent)).toEqual(['已证实'])
    expect(tags(cardOf('标题 f2'), 'promoted')).toHaveLength(0)
    expect(tags(cardOf('标题 f3'), 'promoted')).toHaveLength(0)
    unmount()
    // The day is the brief's, not today's: on the 24th the one confirmed that day is the one marked.
    await show(view([finding('g1', 'p2', { statusNote: PROMOTED, verifiedOn: '2026-11-24' }), finding('g2', 'p1', { statusNote: PROMOTED, verifiedOn: '2026-11-25' })],
      { briefExtra: { date: '2026-11-24' } }), { route: { page: 'today', date: '2026-11-24' } })
    expect(tags(cardOf('标题 g1'), 'promoted')).toHaveLength(1)
    expect(tags(cardOf('标题 g2'), 'promoted')).toHaveLength(0)
  })

  it('marks a finding added after the brief was written 迟到', async () => {
    await show(view([finding('f1', 'p1', { late: true }), finding('f2', 'p2')]))
    expect(tags(cardOf('标题 f1'), 'late').map(tag => tag.textContent)).toEqual(['迟到'])
    expect(tags(cardOf('标题 f2'), 'late')).toHaveLength(0)
  })

  it('marks the AI’s own inference 推论', async () => {
    await show(view([finding('f1', 'p1', { inference: true }), finding('f2', 'p2')]))
    expect(tags(cardOf('标题 f1'), 'inference').map(tag => tag.textContent)).toEqual(['推论'])
    expect(tags(cardOf('标题 f2'), 'inference')).toHaveLength(0)
  })

  it('keeps the words it matches on in step with the host', () => {
    expect(PROMOTED).toBe(PROMOTED_NOTE)
    expect(VERIFY_BUDGET).toBe(VERIFY_BUDGET_NOTE)
    const unseen = { url: 'https://a.example/x', isOfficial: false, syndicationGroup: null, openedVia: 'unopened', quoteFound: null, supportsClaim: null } as const
    expect(judge({ claimKind: 'third-party', evidence: [unseen], firstSeen: new Date(), now: new Date() }).note).toBe(UNOPENED)
  })
})

describe('reading', () => {
  it('marks a card read after it leaves the viewport', async () => {
    const { api, context } = await show(view([finding('f1', 'p1'), finding('f2', 'p2'), finding('f3', 'p3', { read: true })]))
    const reads = () => api.requests.filter(r => r.method === 'POST' && /^findings\//.test(r.path)).map(r => r.path)
    // Rendering marks nothing, and a card that has not yet been in the viewport is not read when the observer first reports it outside.
    expect(reads()).toEqual([])
    const [first, second, third] = cards() as [HTMLElement, HTMLElement, HTMLElement]
    await inView(first, false)
    await inView(second, false)
    expect(reads()).toEqual([])
    // In view is not read; out of view after having been in it is.
    await inView(first, true)
    expect(reads()).toEqual([])
    expect(first.hasAttribute('data-read')).toBe(false)
    await inView(first, false)
    expect(reads()).toEqual(['findings/f1/read'])
    expect(first.hasAttribute('data-read')).toBe(true)
    expect(second.hasAttribute('data-read')).toBe(false)
    // What was read before already shows faded, and is not watched again.
    expect(third.hasAttribute('data-read')).toBe(true)
    expect(FakeObserver.all.some(observer => observer.targets.has(third))).toBe(false)
    // The middle column and the sidebar count are read again afterwards.
    expect(context.refresh).toHaveBeenCalledTimes(1)
    // A card is marked once: it is not watched any more.
    expect(FakeObserver.all.some(observer => observer.targets.has(first))).toBe(false)
  })

  it('reads the state once for cards that leave together', async () => {
    const { api, context } = await show(view([finding('f1', 'p1'), finding('f2', 'p2')]))
    const [first, second] = cards() as [HTMLElement, HTMLElement]
    await inView(first, true)
    await inView(second, true)
    await act(async () => { report(first, false); report(second, false) })
    await settle()
    expect(api.requests.filter(r => r.method === 'POST').map(r => r.path)).toEqual(['findings/f1/read', 'findings/f2/read'])
    expect(context.refresh).toHaveBeenCalledTimes(1)
  })

  it('shows a card unread again when marking it did not reach the server', async () => {
    const { context } = await show(view([finding('f1', 'p1')]), {}, { 'POST findings/:id/read': fail(500, '前哨内部出错，详情见 DSH 日志') })
    const [card] = cards() as [HTMLElement]
    await inView(card, true)
    await inView(card, false)
    expect(card.hasAttribute('data-read')).toBe(false)
    expect(context.refresh).not.toHaveBeenCalled()
  })

  it('marks every card read on 全部已读 and reads the state again', async () => {
    const { api, context } = await show(view([finding('f1', 'p1'), finding('f2', 'p2')], { minor: [finding('m1', 'p4', { importance: 'minor' })] }))
    const readAll = () => document.querySelector<HTMLButtonElement>('.op-day-nav button:last-child')!
    expect(readAll().textContent).toBe('全部已读')
    expect(readAll().disabled).toBe(false)
    await click(readAll())
    const posted = api.requests.filter(r => r.method === 'POST')
    expect(posted.map(r => [r.path, r.body])).toEqual([['brief/read-all', { date: '2026-11-25' }]])
    expect(cards().every(card => card.hasAttribute('data-read'))).toBe(true)
    expect(context.refresh).toHaveBeenCalledTimes(1)
    // Nothing is left to mark.
    expect(readAll().disabled).toBe(true)
  })

  it('says so when 全部已读 fails', async () => {
    const { context } = await show(view([finding('f1', 'p1')]), {}, { 'POST brief/read-all': fail(404, '这一天没有哨报') })
    await click('全部已读')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('这一天没有哨报')
    expect(cards().some(card => card.hasAttribute('data-read'))).toBe(false)
    expect(context.refresh).not.toHaveBeenCalled()
  })

  it('lowers the middle column’s count once a card is read', async () => {
    let unread = 2
    const api = stubApi({
      'GET state': () => state({ todayUnread: unread, tracks: [track('t1', 'Personal Agent', [tracked(doubao)])] }),
      'GET brief': view([finding('f1', 'p1'), finding('f2', 'p1')]),
      'POST findings/:id/read': () => { unread--; return { ok: true } },
      'POST brief/read-all': () => { unread = 0; return { ok: true } },
    })
    await mount(<App t={t} />)
    const count = () => all('.op-mid .op-row').find(row => row.textContent?.startsWith('今日哨报'))?.querySelector('.op-row-end')?.textContent
    expect(count()).toBe('2 条新')
    const [first] = cards() as [HTMLElement]
    await inView(first, true)
    await inView(first, false)
    expect(api.requests.filter(request => request.path === 'state')).toHaveLength(2)
    expect(count()).toBe('1 条新')
    // Everything read: the count goes.
    await click('全部已读')
    expect(count()).toBeUndefined()
  })

  it('does not watch for reading when the browser has no IntersectionObserver', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    await show(view([finding('f1', 'p1')]))
    expect(cards()).toHaveLength(1)
  })
})

describe('actions', () => {
  const ready = (ids: string[]) => ({ catalog: { list: { getSnapshot: () => ({ phase: 'ready', byId: Object.fromEntries(ids.map(id => [id, {}])) }) }, refresh: vi.fn(async () => {}) }, open: vi.fn() })

  it('opens a followup session in the workspace', async () => {
    const sessions = ready(['s-1'])
    const { api } = await show(view([finding('f1', 'p1'), finding('f2', 'p2')]), { sessions: sessions as never })
    await click(inside(cardOf('标题 f2'), '追问')!)
    expect(api.requests.filter(r => r.path === 'followup').map(r => [r.method, r.body])).toEqual([['POST', { findingId: 'f2' }]])
    expect(sessions.open).toHaveBeenCalledWith('s-1')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  })

  it('waits for the session to be listed, and says so when it is not', async () => {
    // Listed only after the catalog is read again, as a session just created is.
    let listed = false
    const sessions = { catalog: { list: { getSnapshot: () => ({ phase: 'ready', byId: listed ? { 's-1': {} } : {} }) }, refresh: vi.fn(async () => { listed = true }) }, open: vi.fn() }
    await show(view([finding('f1', 'p1')]), { sessions: sessions as never })
    await click(inside(cardOf('标题 f1'), '追问')!)
    expect(sessions.catalog.refresh).toHaveBeenCalled()
    expect(sessions.open).toHaveBeenCalledWith('s-1')
    unmount()

    const missing = ready([])
    await show(view([finding('f1', 'p1')]), { sessions: missing as never })
    await click(inside(cardOf('标题 f1'), '追问')!)
    expect(missing.open).not.toHaveBeenCalled()
    expect(cardOf('标题 f1').querySelector('[role="alert"]')?.textContent).toBe('追问会话已经建好，但会话列表里还没出现；稍后在 DSH 的会话列表里就能找到。')
    unmount()

    const notReady = { catalog: { list: { getSnapshot: () => ({ phase: 'loading', byId: {} }) }, refresh: vi.fn(async () => {}) }, open: vi.fn() }
    await show(view([finding('f1', 'p1')]), { sessions: notReady as never })
    await click(inside(cardOf('标题 f1'), '追问')!)
    expect(cardOf('标题 f1').querySelector('[role="alert"]')?.textContent).toBe('追问会话已经建好，但会话列表还没准备好；稍后在 DSH 的会话列表里就能找到。')
    expect(new SessionNavigationError('not-listed').code).toBe('not-listed')
  })

  it('says so when the followup cannot be started', async () => {
    const sessions = ready(['s-1'])
    await show(view([finding('f1', 'p1')]), { sessions: sessions as never }, { 'POST followup': fail(500, '前哨内部出错，详情见 DSH 日志') })
    await click(inside(cardOf('标题 f1'), '追问')!)
    expect(cardOf('标题 f1').querySelector('[role="alert"]')?.textContent).toBe('前哨内部出错，详情见 DSH 日志')
    expect(sessions.open).not.toHaveBeenCalled()
    // Without DSH's sessions there is nothing to open it in.
    unmount()
    await show(view([finding('f1', 'p1')]), { sessions: undefined })
    await click(inside(cardOf('标题 f1'), '追问')!)
    expect(cardOf('标题 f1').querySelector('[role="alert"]')?.textContent).toBe('追问会话已经建好，但会话列表还没准备好；稍后在 DSH 的会话列表里就能找到。')
  })

  it('jumps to the changed dimension on 看改动', async () => {
    // f1 names 定位 first, but its 定位 edit did not go through: 看改动 opens the card that did change.
    const changed = finding('f1', 'p1', { dimensions: ['positioning', 'monetization'] })
    const named = finding('f2', 'p2', { dimensions: ['positioning'] })
    const { context } = await show(view([changed, named], { changed: { f1: ['monetization'] } }))
    await click(inside(cardOf('标题 f1'), '看改动 →')!)
    expect(context.navigate).toHaveBeenCalledWith({ page: 'product', productId: 'p1', tab: 'dossier', expand: 'monetization' })
    // A verified finding that changed no card (whatever it names) has nothing to jump to.
    expect(cardOf('标题 f2').querySelector('.op-card-changed')).toBeNull()
    expect(inside(cardOf('标题 f2'), '看改动 →')).toBeUndefined()
    expect(inside(cardOf('标题 f2'), '追问')).toBeDefined()
  })
})

describe('the rest of the day', () => {
  it('lists the products with no news at the end', async () => {
    await show(view([finding('f1', 'p1')], { briefExtra: { quietProductIds: ['p4', 'p5'] } }))
    const quiet = document.querySelector('.op-quiet')!
    expect(quiet.firstElementChild?.textContent).toBe('今天没动静：')
    // Each with its icon and name.
    expect([...quiet.querySelectorAll('.op-quiet-item')].map(item => item.lastElementChild?.textContent)).toEqual(['蚂蚁灵光', 'Grok Bots'])
    expect(quiet.querySelectorAll('.op-icon')).toHaveLength(2)
    // It is the last thing on the page.
    expect(document.querySelector('.op-today')!.lastElementChild).toBe(quiet)
  })

  it('shows only 今天没有值得看的变化 on a no-news day', async () => {
    await show(view([], { briefExtra: { gist: '今天没有值得看的变化', quietProductIds: ['p1', 'p2'] } }))
    expect(text()).toContain('今天没有值得看的变化')
    expect(all('.op-card')).toHaveLength(0)
    // No summary block with the AI mark, no filter, no 全部已读, no list of quiet products.
    expect(document.querySelector('.op-gist')).toBeNull()
    expect(document.querySelector('.op-filter')).toBeNull()
    expect(document.querySelector('.op-quiet')).toBeNull()
    expect(all('.op-day-nav button').map(button => button.textContent)).toEqual(['‹ 昨天'])
    expect(text()).not.toContain('今天没动静')
    expect(meta()).toBe('08:12 跑完 · 6 个产品')
  })

  it('shows the no-news line when every finding of the brief was withdrawn since', async () => {
    await show({ ...view([], { briefExtra: { gist: '今天有一条重要更新', findingIds: ['gone'] } }) })
    expect(text()).toContain('今天没有值得看的变化')
    expect(text()).not.toContain('今天有一条重要更新')
  })

  it('names budget-skipped products', async () => {
    await show(view([finding('f1', 'p1')], { briefExtra: { skipped: [{ productId: 'p4', reason: '今日总预算已用完' }, { productId: 'p5', reason: '今日总预算已用完' }] } }))
    expect(notes()).toEqual(['因预算未跑：蚂蚁灵光、Grok Bots（今日总预算已用完）'])
    // The products that did not run are not "no news".
    expect(document.querySelector('.op-quiet')).toBeNull()
  })

  it('shows each reason once, over the products it stopped', async () => {
    await show(view([finding('f1', 'p1')], { briefExtra: { skipped: [
      { productId: 'p4', reason: '今日总预算已用完' }, { productId: 'p5', reason: '该产品今日预算已用完' }, { productId: 'p6', reason: '今日总预算已用完' },
    ] } }))
    expect(notes()).toEqual(['因预算未跑：蚂蚁灵光、Ray-Ban Meta（今日总预算已用完）', '因预算未跑：Grok Bots（该产品今日预算已用完）'])
  })

  it('names the products that failed, with why, and those whose check the budget cut short', async () => {
    await show(view([finding('f1', 'p1')], { briefExtra: { skipped: [
      { productId: 'p3', reason: '核查没有完成：模型超时', failed: true },
      { productId: 'p2', reason: VERIFY_BUDGET },
      { productId: 'p4', reason: '今日总预算已用完' },
    ] } }))
    expect(notes()).toEqual([
      '因预算未跑：蚂蚁灵光（今日总预算已用完）',
      'Meta Muse的新消息核查因预算未完成，明天继续',
      '未能更新：OpenAI Dots（核查没有完成：模型超时）',
    ])
  })

  it('does not promise tomorrow’s check for a product paused since (M1.6)', async () => {
    const paused = everyone.map(p => p.id === 'p2' ? { ...p, status: 'paused' as const } : p)
    const answer = view([finding('f1', 'p1')], { products: paused, briefExtra: { skipped: [{ productId: 'p2', reason: VERIFY_BUDGET }] } })
    await show(answer)
    expect(notes()).toEqual(['Meta Muse的新消息核查因预算未完成；Meta Muse已暂停，恢复跟踪后接着核'])
    unmount()
    await show(answer, { t: tEn })
    expect(notes()).toEqual(['The check of Meta Muse’s news ran out of budget; Meta Muse is paused, so it continues once you resume it'])
  })

  it('speaks English when DSH does: the host’s reasons too, nested ones included, and English list commas', async () => {
    await show(view([finding('f1', 'p1')], { briefExtra: { skipped: [
      { productId: 'p4', reason: '今日总预算已用完' }, { productId: 'p6', reason: '今日总预算已用完' },
      { productId: 'p3', reason: '核查没有完成：前哨已停止', failed: true },
      { productId: 'p5', reason: '429 Too Many Requests', failed: true },
    ] } }), { t: tEn })
    expect(notes()).toEqual([
      'Not run, over budget: 蚂蚁灵光, Ray-Ban Meta (Today’s total budget is used up)',
      'Could not update: OpenAI Dots (The check did not finish: Outpost was stopping)',
      'Could not update: Grok Bots (429 Too Many Requests)',
    ])
  })

  it('still names skipped products on a day with no news', async () => {
    await show(view([], { briefExtra: { gist: '今天没有值得看的变化', skipped: [{ productId: 'p1', reason: '今日总预算已用完' }] } }))
    expect(text()).toContain('今天没有值得看的变化')
    expect(notes()).toEqual(['因预算未跑：豆包·小豆（今日总预算已用完）'])
  })

  it('says when the first brief will arrive when there is none yet', async () => {
    await show({ brief: null, findings: [], products: [], sources: [], changed: {}, prevDate: null })
    expect(text()).toContain('还没有哨报：前哨每天 08:00 跑完后会出现在这里')
    expect(all('.op-card')).toHaveLength(0)
    expect(title()).toBe('11月25日 · 周三')
    // The way to earlier days stays.
    expect(document.querySelector<HTMLButtonElement>('.op-day-nav button')!.textContent).toBe('‹ 昨天')
    unmount()
    // Without the time, it leaves the time out.
    await show({ brief: null, findings: [], products: [], sources: [], changed: {}, prevDate: '2026-11-24' }, { state: undefined })
    expect(text()).toContain('还没有哨报：前哨每天跑完后会出现在这里')
    expect(document.querySelector<HTMLButtonElement>('.op-day-nav button')!.disabled).toBe(false)
  })

  it('says an earlier day has no brief', async () => {
    await show({ brief: null, findings: [], products: [], sources: [], changed: {}, prevDate: null }, { route: { page: 'today', date: '2026-11-20' } })
    expect(title()).toBe('11月20日 · 周五')
    expect(text()).toContain('这一天没有哨报')
    expect(text()).not.toContain('还没有哨报')
  })

  it('shows the server’s sentence when the brief cannot be read', async () => {
    await show(fail(500, '前哨内部出错，详情见 DSH 日志'))
    expect(text()).toContain('前哨内部出错，详情见 DSH 日志')
    expect(title()).toBe('今日哨报')
  })
})
