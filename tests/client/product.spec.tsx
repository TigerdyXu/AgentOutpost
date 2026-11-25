// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Dimension, Finding, Product as ProductRecord, RunStatus, Source, Span } from '../../src/core/types.ts'
import type { ProductView } from '../../src/host/api.ts'
import { Product } from '../../src/client/pages/Product.tsx'
import { App } from '../../src/client/shell/App.tsx'
import type { Route } from '../../src/client/shell/route.ts'
import type { Shell } from '../../src/client/shell/context.ts'
import { all, card, click, facts, fail, finding, find, mount, product, productView, run, settle, source, state, stubApi, t, text, track, tracked, type, unmount } from '../fixtures/client.tsx'

// ---- one product: 豆包·小豆, with the six default dimensions ----

/** The clock the page reads: 09:00 on 25 November, the reader's own time. */
const NOW = new Date(2026, 10, 25, 9, 0)
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()
/** 8 o'clock on the reader's clock of the given day of November 2026 (so the day shown does not depend on the time zone). */
const nov = (day: number) => new Date(2026, 10, day, 8, 0).toISOString()
const DIMENSIONS: Dimension[] = [
  { key: 'positioning', label: '定位' }, { key: 'audience', label: '目标人群' }, { key: 'scenarios', label: '价值场景' },
  { key: 'experience', label: '体验' }, { key: 'technology', label: '关键技术' }, { key: 'business', label: '商业化' },
]
const doubao = product('p1', '豆包·小豆', { company: '字节跳动', createdAt: ago(24 * 7) })
const muse = product('p2', 'Meta Muse')
const shellState = state({ tracks: [track('t1', 'Personal Agent', [tracked(doubao), tracked(muse)], { dimensions: DIMENSIONS })] })

/** The range of `part` inside `body`. */
const within = (body: string, part: string): Span => {
  const start = body.indexOf(part)
  if (start < 0) throw new Error(`${part} is not in the body`)
  return { start, end: start + part.length }
}
const sources = [
  source('s1', { title: '官方发布会', publisher: '字节跳动', publishedAt: '2026-09-16', kind: 'official', isOfficial: true }),
  source('s2', { title: '官网产品页', publisher: '豆包官网', publishedAt: null, kind: 'official', isOfficial: true }),
  source('s3', { title: '官方公众号', publisher: '豆包', publishedAt: '2026-11-25', kind: 'official', isOfficial: true, quote: '11 月 25 日起全量' }),
  source('s4', { title: '用户评价合集', publisher: '某社区', publishedAt: '2026-11-10', kind: 'review' }),
]

const POSITIONING = '小豆是豆包从「聊天助手」走向「办事代理」的那一步。[1][2]\n11-25 起对全部安卓用户开放，不再需要邀请码。[3] 小豆押的是「手机上的通用跑腿」。'
const positioning = card('p1', 'positioning', {
  version: 3, summary: '住在豆包里的个人代理：记住你的习惯，替你跨 App 跑腿。', bullets: ['办事代理', '全量开放'], body: POSITIONING, sourceIds: ['s1', 's2', 's3'],
  addedSpans: [within(POSITIONING, '11-25 起对全部安卓用户开放，不再需要邀请码。[3]')], inferenceSpans: [within(POSITIONING, '小豆押的是「手机上的通用跑腿」。')],
  changeNote: '补上「安卓全量、iOS 内测」', createdAt: ago(1),
})
const cards = [
  positioning,
  card('p1', 'audience', { bullets: ['豆包现有重度用户', '一二线上班族'], sourceIds: ['s1', 's4'], body: '首先是豆包现有的重度用户。[1][2]' }),
  card('p1', 'scenarios', { bullets: ['出差订票、改签[2]'], sourceIds: ['s1', 's4'], createdAt: ago(100) }),
  card('p1', 'experience', { sourceIds: ['s4'] }),
  card('p1', 'technology', { sourceIds: ['s1'] }),
]
const history = {
  positioning: [
    { version: 1, changeNote: '建档', createdAt: nov(18) },
    { version: 2, changeNote: '加了与 Meta Muse、蚂蚁灵光的路线对比', createdAt: nov(22) },
    { version: 3, changeNote: '补上「安卓全量、iOS 内测」', createdAt: ago(1) },
  ],
  audience: [{ version: 1, changeNote: '建档', createdAt: nov(18) }],
}
/** 商业化 has no card: its card was rejected, or the dimension is new. */
const view = (extra: Partial<ProductView> = {}): ProductView => productView(doubao, {
  facts: facts('p1'), cards, history, sources, dimensions: DIMENSIONS, ...extra,
})

const route = (extra: Partial<Extract<Route, { page: 'product' }>> = {}): Route => ({ page: 'product', productId: 'p1', tab: 'dossier', ...extra })
const noFindings = { findings: [] as Finding[], sources: [] as Source[] }

/** The product page over a stubbed API. */
async function show(answer: ProductView | ReturnType<typeof fail> = view(), shell: Partial<Shell> = {}, extra: Record<string, unknown> = {}) {
  const api = stubApi({ 'GET products/:id': answer, 'GET products/:id/findings': noFindings, 'PATCH products/:id': doubao, ...extra })
  const context = await mount(<Product />, { state: shellState, route: route(), ...shell })
  return { api, context }
}

const dcards = () => all('.op-dcard')
const dcard = (label: string) => dcards().find(item => item.querySelector('.op-dcard-name')?.textContent === label)!
const expanded = () => dcards().filter(item => item.hasAttribute('data-expanded')).map(item => item.querySelector('.op-dcard-name')?.textContent)
const tags = (scope: ParentNode, kind: string) => [...scope.querySelectorAll('.op-tag')].filter(tag => tag.getAttribute('data-kind') === kind)
/** What matches `selector` inside `scope`. */
const inside = (scope: ParentNode, selector: string) => [...scope.querySelectorAll<HTMLElement>(selector)]
const control = (name: string) => find(name, 'button, a, [role="tab"], [role="menuitem"]')
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
/** The text of `element` without the labels the page hangs on it (推论 and the like). */
const plain = (element: Element) => {
  const copy = element.cloneNode(true) as Element
  for (const tag of copy.querySelectorAll('.op-tag')) tag.remove()
  return copy.textContent
}

// ---- a stand-in for the browser's IntersectionObserver, and for scrolling ----

class FakeObserver {
  static all: FakeObserver[] = []
  readonly targets = new Set<Element>()
  constructor(readonly callback: IntersectionObserverCallback) { FakeObserver.all.push(this) }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  takeRecords() { return [] }
}
const scrollIntoView = vi.fn()

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], now: NOW })
  FakeObserver.all = []
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  scrollIntoView.mockClear()
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView })
})
afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  localStorage.clear()
})

describe('the header', () => {
  it('shows the product, its status and when it was built and last changed', async () => {
    await show()
    expect(document.querySelector('.op-product h1')?.textContent).toBe('豆包·小豆')
    expect(document.querySelector('.op-status')?.textContent).toBe('跟踪中')
    // The company, the day the baseline was written, and the newest card's time (today, so the day is not repeated).
    expect(document.querySelector('.op-phead-meta')?.textContent).toBe('字节跳动 · 11-18 建档 · 今天 08:00 更新')
    expect(document.querySelector('.op-phead .op-icon')?.textContent).toBe('豆')
    expect(all('.op-phead-actions button').map(button => button.textContent)).toEqual(['全部展开', '⋯', '立即更新'])
  })

  it('names a paused product, and one still being built', async () => {
    await show(view({ product: { ...doubao, status: 'paused' } }))
    expect(document.querySelector('.op-status')?.textContent).toBe('已暂停')
    unmount()
    await show(view({ product: { ...doubao, status: 'baselining' }, cards: [], history: {}, progress: { done: 1, total: 6 } }))
    expect(document.querySelector('.op-status')?.textContent).toBe('建档中')
    // Nothing is written yet: no baseline day or update time to quote.
    expect(document.querySelector('.op-phead-meta')?.textContent).toBe('字节跳动')
  })

  it('has the tabs 档案, 动态 and 来源 with their counts, and no 专题 tab', async () => {
    const f = [finding('f1', 'p1'), finding('f2', 'p1', { status: 'unconfirmed', statusNote: '只有一个来源' }), finding('f3', 'p1', { status: 'unproven', statusNote: '只有一个来源' })]
    const { context } = await show(view(), {}, { 'GET products/:id/findings': { findings: f, sources: [] } })
    const tabs = all('[role="tab"]')
    // 动态 counts what the tab lists open: the unproven one is folded away and has its own count there.
    expect(tabs.map(tab => tab.textContent)).toEqual(['档案', '动态2', '来源4'])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(all('[role="tabpanel"]')).toHaveLength(1)
    await click(control('动态2'))
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p1', tab: 'feed' })
    await click(control('来源4'))
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p1', tab: 'sources' })
    // The tab already shown is not navigated to again.
    const moves = vi.mocked(context.navigate).mock.calls.length
    await click(control('档案'))
    expect(vi.mocked(context.navigate).mock.calls).toHaveLength(moves)
    unmount()
    const other = await show(view(), { route: route({ tab: 'sources' }) })
    await click(control('档案'))
    expect(other.context.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p1', tab: 'dossier' })
  })

  it('shows the tab of the route, and 全部展开 only on the profile', async () => {
    await show()
    expect(control('全部展开')).toBeTruthy()
    unmount()
    await show(view(), { route: route({ tab: 'sources' }) })
    expect(all('[role="tab"]').map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true'])
    expect(all('button').some(button => button.textContent === '全部展开')).toBe(false)
  })

  it('says why the profile cannot be read', async () => {
    await show(fail(404, '找不到这个产品'))
    // The name the column knows stays as the title while the profile is not there.
    expect(document.querySelector('.op-product h1')?.textContent).toBe('豆包·小豆')
    expect(document.querySelector('.op-product [role="alert"]')?.textContent).toBe('找不到这个产品')
  })
})

describe('the profile', () => {
  it('shows the key facts, the positioning sentence and one card per dimension', async () => {
    await show()
    const facts = all('.op-fact').map(fact => [fact.querySelector('.op-fact-k')?.textContent, fact.querySelector('.op-fact-v')?.textContent])
    expect(facts).toEqual([['形态', 'App 内代理'], ['平台', '安卓 · iOS 内测'], ['价格', '免费'], ['首发', '2026-09'], ['对标', 'Meta Muse、蚂蚁灵光']])
    expect(document.querySelector('.op-positioning')?.textContent).toBe('住在豆包里的个人代理：记住你的习惯，替你跨 App 跑腿。')
    expect(dcards().map(item => item.querySelector('.op-dcard-name')?.textContent)).toEqual(['定位', '目标人群', '价值场景', '体验', '关键技术', '商业化'])
    // A card is the dimension's name, its conclusions, how many sources stand behind it, and the way to open it.
    const audience = dcard('目标人群')
    expect([...audience.querySelectorAll('li')].map(item => item.textContent)).toEqual(['豆包现有重度用户', '一二线上班族'])
    expect(audience.querySelector('.op-dcard-count')?.textContent).toBe('2 个来源')
    expect(audience.querySelector('button')?.textContent).toBe('展开')
    expect(audience.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    // The conclusions carry their citations.
    expect(dcard('价值场景').querySelector('li .op-cite')?.textContent).toBe('[2]')
    // Nothing is open, and the long text is not on the page yet.
    expect(expanded()).toEqual([])
    expect(text()).not.toContain('首先是豆包现有的重度用户。')
  })

  it('fills the width with a grid of cards from 300px', async () => {
    await show()
    // jsdom does not lay anything out: the rule itself is what the stylesheet must say.
    const css = (await import('../../src/client/styles.css?raw')).default
    expect(css).toMatch(/\.op-dgrid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(300px,\s*1fr\)\)/)
    expect(css).toMatch(/\.op-dcard\[data-expanded\]\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/)
    expect(css).not.toMatch(/border-left|border-inline-start/)
  })

  it('shows — for a fact it does not have, and leaves the positioning line out without a positioning card', async () => {
    await show(view({ facts: facts('p1', { platforms: '', rivals: [] }), cards: cards.slice(1) }))
    expect(all('.op-fact').map(fact => fact.querySelector('.op-fact-v')?.textContent)).toEqual(['App 内代理', '—', '免费', '2026-09', '—'])
    expect(document.querySelector('.op-positioning')).toBeNull()
    unmount()
    // No facts at all: every one is —, and the strip stays.
    await show(view({ facts: null }))
    expect(all('.op-fact').map(fact => fact.querySelector('.op-fact-v')?.textContent)).toEqual(['—', '—', '—', '—', '—'])
  })

  it('marks only a card changed today as 今天改过, never a first version', async () => {
    // 定位 is version 3, written an hour ago; the others are first versions from the baseline.
    await show()
    expect(tags(dcard('定位'), 'fresh').map(tag => tag.textContent)).toEqual(['今天改过'])
    expect(all('.op-dcard').filter(item => tags(item, 'fresh').length > 0).map(item => item.querySelector('.op-dcard-name')?.textContent)).toEqual(['定位'])
    unmount()
    // A first version written just now is the profile being set up, not a change.
    await show(view({ cards: [card('p1', 'positioning', { version: 1, createdAt: ago(1) }), card('p1', 'audience', { version: 2, createdAt: ago(2) })], history: {} }))
    expect(all('.op-dcard').filter(item => tags(item, 'fresh').length > 0).map(item => item.querySelector('.op-dcard-name')?.textContent)).toEqual(['目标人群'])
  })

  it('says 今天改过 on a card changed today, and not on one changed yesterday whose new text is still highlighted', async () => {
    const body = '旧的一句。新加的一句。[1]'
    const added = [within(body, '新加的一句。[1]')]
    // NOW is 09:00: two hours ago is today, ten hours ago is 23:00 yesterday.
    await show(view({
      cards: [
        card('p1', 'positioning', { version: 2, body, sourceIds: ['s1'], addedSpans: added, createdAt: ago(2) }),
        card('p1', 'audience', { version: 2, body, sourceIds: ['s1'], addedSpans: added, createdAt: ago(10) }),
      ], history: {},
    }))
    // Collapsed: the tag is on the header of the card of today only.
    expect(tags(dcard('定位'), 'fresh')).toHaveLength(1)
    expect(tags(dcard('目标人群'), 'fresh')).toHaveLength(0)
    // Opened: the same, and yesterday's added text is still light blue (within 72 hours).
    await click('全部展开')
    expect(tags(dcard('定位'), 'fresh')).toHaveLength(1)
    expect(tags(dcard('目标人群'), 'fresh')).toHaveLength(0)
    expect(inside(dcard('定位'), '.op-added').map(mark => mark.textContent).join('')).toBe('新加的一句。[1]')
    expect(inside(dcard('目标人群'), '.op-added').map(mark => mark.textContent).join('')).toBe('新加的一句。[1]')
  })

  it('shows 暂无可核实的信息 for a rejected dimension', async () => {
    await show()
    // 商业化 is a dimension of the track and has no card.
    const empty = dcard('商业化')
    expect(empty.textContent).toContain('暂无可核实的信息')
    expect(empty.getAttribute('data-state')).toBe('empty')
    // There is nothing to open on it, and it is not mistaken for one being built.
    expect(empty.querySelector('button')).toBeNull()
    expect(empty.textContent).not.toContain('建档中')
    expect(dcard('定位').textContent).not.toContain('暂无可核实的信息')
  })

  it('shows progress while the product is being baselined', async () => {
    // Two cards are written; the other four are on their way.
    await show(view({ product: { ...doubao, status: 'baselining' }, cards: cards.slice(1, 3), history: {}, facts: null, progress: { done: 2, total: 6 } }))
    const bar = document.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('2')
    expect(bar.getAttribute('aria-valuemax')).toBe('6')
    expect(document.querySelector('.op-baseline')?.textContent).toContain('建档进度 2/6')
    // One placeholder per dimension still to come, saying 建档中; the cards already written show as usual.
    const waiting = dcards().filter(item => item.getAttribute('data-state') === 'baselining')
    expect(waiting.map(item => item.querySelector('.op-dcard-name')?.textContent)).toEqual(['定位', '体验', '关键技术', '商业化'])
    expect(waiting.every(item => item.textContent?.includes('建档中'))).toBe(true)
    expect(text()).not.toContain('暂无可核实的信息')
    expect(dcard('目标人群').querySelector('li')?.textContent).toBe('豆包现有重度用户')
    // Written cards can be opened already.
    expect(dcard('目标人群').querySelector('button')?.textContent).toBe('展开')
  })

  it('says it is building the profile when no progress is reported yet', async () => {
    await show(view({ product: { ...doubao, status: 'baselining' }, cards: [], history: {}, facts: null, progress: null }))
    expect(document.querySelector('[role="progressbar"]')).toBeNull()
    expect(document.querySelector('.op-baseline')?.textContent).toBe('正在建档，进度还没有报上来')
    expect(dcards().every(item => item.getAttribute('data-state') === 'baselining')).toBe(true)
    expect(dcards()).toHaveLength(6)
  })

  it('shows a card of a dimension the track no longer has, after the others', async () => {
    await show(view({ dimensions: DIMENSIONS.slice(0, 2), cards: [...cards.slice(0, 2), card('p1', 'pricing', { bullets: ['按次收费'] })] }))
    expect(dcards().map(item => item.querySelector('.op-dcard-name')?.textContent)).toEqual(['定位', '目标人群', 'pricing'])
  })
})

describe('opening a card', () => {
  it('expands the routed dimension and shows its history', async () => {
    await show(view(), { route: route({ expand: 'positioning' }) })
    expect(expanded()).toEqual(['定位'])
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView.mock.contexts[0]).toBe(dcard('定位'))
    const open = dcard('定位')
    // The full text, its sources as chips with their numbers.
    expect(plain(open.querySelector('.op-dcard-text')!)).toBe(POSITIONING)
    const chips = [...open.querySelectorAll('.op-dcard-sources .op-source')]
    expect(chips.map(chip => chip.textContent)).toEqual(['[1]字节跳动 · 09-16官方', '[2]豆包官网官方', '[3]豆包 · 11-25官方'])
    // How it changed, newest first, the newest with the solid dot.
    expect(open.querySelector('.op-history-title')?.textContent).toBe('这一节怎么变过来的')
    const items = [...open.querySelectorAll('.op-history-item')]
    expect(items.map(item => [item.querySelector('.op-history-date')?.textContent, item.querySelector('.op-history-note')?.textContent])).toEqual([
      ['11-25', '补上「安卓全量、iOS 内测」'],
      ['11-22', '加了与 Meta Muse、蚂蚁灵光的路线对比'],
      ['11-18', '建档'],
    ])
    expect(items.map(item => item.hasAttribute('data-latest'))).toEqual([true, false, false])
    // The others stay closed, the expanded one offers 收起 ↑ and the page says it is open.
    expect(open.querySelector('.op-dcard-toggle')?.textContent).toBe('收起 ↑')
    expect(open.querySelector('.op-dcard-toggle')?.getAttribute('aria-expanded')).toBe('true')
    expect(dcard('目标人群').hasAttribute('data-expanded')).toBe(false)
  })

  it('opens and closes a card from its own button, keeping the others', async () => {
    await show()
    await click(dcard('目标人群').querySelector('button')!)
    expect(expanded()).toEqual(['目标人群'])
    expect(plain(dcard('目标人群').querySelector('.op-dcard-text')!)).toBe('首先是豆包现有的重度用户。[1][2]')
    await click(dcard('价值场景').querySelector('button')!)
    expect(expanded()).toEqual(['目标人群', '价值场景'])
    await click(control('收起 ↑'))
    expect(expanded()).toEqual(['价值场景'])
    // Opening a card by hand does not scroll the page.
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('says a card has no history when it has no versions on record', async () => {
    await show(view({ history: {} }), { route: route({ expand: 'audience' }) })
    expect(dcard('目标人群').querySelectorAll('.op-history-item')).toHaveLength(0)
    expect(plain(dcard('目标人群').querySelector('.op-dcard-text')!)).toBe('首先是豆包现有的重度用户。[1][2]')
  })

  it('opens the routed card once the profile has arrived, and scrolls to it', async () => {
    const api = stubApi({ 'GET products/:id': () => view(), 'GET products/:id/findings': noFindings })
    await mount(<Product />, { state: shellState, route: route({ expand: 'audience' }) })
    expect(api.requests.some(request => request.path === 'products/p1')).toBe(true)
    expect(expanded()).toEqual(['目标人群'])
    expect(scrollIntoView.mock.contexts).toEqual([dcard('目标人群')])
  })

  it('expand-all opens every card', async () => {
    await show()
    await click('全部展开')
    // Every card that has something to open: 商业化 has nothing.
    expect(expanded()).toEqual(['定位', '目标人群', '价值场景', '体验', '关键技术'])
    expect(dcard('商业化').hasAttribute('data-expanded')).toBe(false)
    expect(all('.op-history').length).toBe(5)
    // The button then closes them all again.
    expect(all('button').some(button => button.textContent === '全部展开')).toBe(false)
    await click('全部收起')
    expect(expanded()).toEqual([])
    expect(all('button').some(button => button.textContent === '全部展开')).toBe(true)
  })

  it('an open card stays open across the page reading the product again', async () => {
    let calls = 0
    stubApi({ 'GET products/:id': () => { calls++; return view() }, 'GET products/:id/findings': noFindings })
    await mount(<Product />, { state: shellState, route: route() })
    await click(dcard('目标人群').querySelector('button')!)
    await advance(5000)
    expect(calls).toBeGreaterThan(1)
    expect(expanded()).toEqual(['目标人群'])
  })

  it('makes an open card span the row, with the text beside its history (the rules in the stylesheet)', async () => {
    const css = (await import('../../src/client/styles.css?raw')).default
    expect(css).toMatch(/\.op-dcard-open\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*2fr\)\s*minmax\(240px,\s*1fr\)/)
    // Narrow: one column.
    expect(css).toMatch(/@container[^{]*max-width[^{]*\{[^@]*\.op-dcard-open\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/)
  })
})

describe('the text of a card', () => {
  const body = (extra: Parameters<typeof card>[2]) => show(view({ cards: [card('p1', 'positioning', { sourceIds: ['s1', 's2', 's3'], createdAt: ago(1), ...extra })], history: {} }), { route: route({ expand: 'positioning' }) })
  const open = () => dcard('定位').querySelector('.op-dcard-text')!
  const marked = () => inside(open(), '.op-added').map(mark => mark.textContent)

  it('highlights added text only within 72 hours', async () => {
    const added = [within(POSITIONING, '11-25 起对全部安卓用户开放，不再需要邀请码。[3]')]
    // Just inside three days counts; just outside does not (the exact edge is the core's `isFresh` test).
    const minutes = (m: number) => new Date(NOW.getTime() - 72 * 3_600_000 + m * 60_000).toISOString()
    await show(view({
      cards: [
        card('p1', 'positioning', { version: 2, body: POSITIONING, sourceIds: ['s1', 's2', 's3'], addedSpans: added, createdAt: ago(2) }),
        card('p1', 'audience', { version: 2, body: POSITIONING, sourceIds: ['s1', 's2', 's3'], addedSpans: added, createdAt: minutes(5) }),
        card('p1', 'scenarios', { version: 2, body: POSITIONING, sourceIds: ['s1', 's2', 's3'], addedSpans: added, createdAt: minutes(-5) }),
        card('p1', 'experience', { version: 2, body: POSITIONING, sourceIds: ['s1', 's2', 's3'], addedSpans: added, createdAt: ago(200) }),
      ], history: {},
    }))
    await click('全部展开')
    const markedIn = (label: string) => inside(dcard(label), '.op-added').map(mark => mark.textContent).join('')
    expect(markedIn('定位')).toBe('11-25 起对全部安卓用户开放，不再需要邀请码。[3]')
    expect(markedIn('目标人群')).toBe('11-25 起对全部安卓用户开放，不再需要邀请码。[3]')
    expect(markedIn('价值场景')).toBe('')
    expect(markedIn('体验')).toBe('')
    // The text itself is there either way, whole.
    expect(plain(dcard('体验').querySelector('.op-dcard-text')!)).toBe(POSITIONING)
    // 今天改过 is about today, not about the 72 hours: only 定位 (version 2, written two hours ago) says it.
    expect(all('.op-dcard').filter(item => tags(item, 'fresh').length > 0).map(item => item.querySelector('.op-dcard-name')?.textContent)).toEqual(['定位'])
  })

  it('tags inference spans 推论', async () => {
    await body({ body: POSITIONING, inferenceSpans: [within(POSITIONING, '小豆押的是「手机上的通用跑腿」。')] })
    const inferred = open().querySelector('.op-infer')!
    expect(inferred.textContent).toBe('小豆押的是「手机上的通用跑腿」。')
    // The tag sits right after the span, and there is one.
    expect(tags(open(), 'inference').map(tag => tag.textContent)).toEqual(['推论'])
    expect(inferred.nextElementSibling).toBe(tags(open(), 'inference')[0])
    // Facts around it carry no tag.
    expect(plain(open())).toBe(POSITIONING)
  })

  it('renders [n] as a citation of the n-th source, which opens its page', async () => {
    await body({ body: POSITIONING })
    const cites = inside(open(), '.op-cite > a')
    expect(cites.map(cite => cite.textContent)).toEqual(['[1]', '[2]', '[3]'])
    expect(cites.map(cite => cite.getAttribute('href'))).toEqual(['https://example.com/s1', 'https://example.com/s2', 'https://example.com/s3'])
    // A marker beyond the sources is shown as it is, not as a link.
    unmount()
    await body({ body: '甲[1]乙[9]。' })
    expect(inside(open(), '.op-cite > a').map(cite => cite.textContent)).toEqual(['[1]'])
    expect(plain(open())).toBe('甲[1]乙[9]。')
  })

  it('renders a span that contains a citation, and spans that touch', async () => {
    const text_ = '甲乙[1]丙丁[2]戊己庚辛'
    // Inference over 乙[1]丙, which holds a citation; added over 丙丁 (overlapping the end of it) and over [2], which touches it.
    await body({
      body: text_,
      inferenceSpans: [within(text_, '乙[1]丙')],
      addedSpans: [within(text_, '丙丁'), within(text_, '[2]')],
    })
    // Every character is there once, in order, whatever wraps it.
    expect(plain(open())).toBe(text_)
    // The inference span holds its citation, and one tag follows it.
    const inferred = open().querySelector('.op-infer')!
    expect(inferred.textContent).toBe('乙[1]丙')
    expect(inferred.querySelectorAll('.op-cite')).toHaveLength(1)
    expect(tags(open(), 'inference')).toHaveLength(1)
    expect(inferred.nextElementSibling).toBe(tags(open(), 'inference')[0])
    // The added spans touch ('丙丁' then '[2]') and show as highlighted text; the citation inside one is still a citation.
    expect(marked().join('')).toBe('丙丁[2]')
    expect(inside(open(), '.op-added .op-cite')).toHaveLength(1)
    // The citation inside the added span stays a link.
    expect(inside(open(), '.op-cite > a').map(cite => cite.textContent)).toEqual(['[1]', '[2]'])
  })

  it('treats spans that touch as one: one tag after the run, one continuous highlight', async () => {
    const text_ = '前文。甲乙丙丁。后文。'
    await body({
      body: text_,
      inferenceSpans: [within(text_, '甲乙'), within(text_, '丙丁')],
      addedSpans: [within(text_, '甲乙'), within(text_, '丙丁。')],
      createdAt: ago(1),
    })
    expect(plain(open())).toBe(text_)
    expect(inside(open(), '.op-infer').map(item => item.textContent)).toEqual(['甲乙丙丁'])
    expect(tags(open(), 'inference')).toHaveLength(1)
    expect(marked().join('')).toBe('甲乙丙丁。')
  })

  it('wraps a span that ends inside a citation marker around the whole marker', async () => {
    const text_ = '甲[12]乙'
    await body({ body: text_, sourceIds: Array.from({ length: 12 }, (_, i) => `s${i + 1}`), inferenceSpans: [{ start: 0, end: 3 }] })
    expect(plain(open())).toBe(text_)
    expect(inside(open(), '.op-cite')).toHaveLength(1)
    expect(open().querySelector('.op-infer')?.textContent).toBe('甲[12]')
  })

  it('ignores spans that are empty, backwards or past the end', async () => {
    await body({ body: '短文。', inferenceSpans: [{ start: 2, end: 2 }, { start: 3, end: 1 }, { start: 50, end: 60 }], addedSpans: [{ start: 1, end: 400 }] })
    expect(plain(open())).toBe('短文。')
    expect(tags(open(), 'inference')).toHaveLength(0)
    // What lies past the end is cut off, not shown.
    expect(marked().join('')).toBe('文。')
  })

  it('keeps the text’s line breaks, a blank line between paragraphs becoming a short gap of its own', async () => {
    await body({ body: '第一段。\n第二行。\n\n第二段。[1]\n\n\n第三段。' })
    expect(open().textContent).toBe('第一段。\n第二行。\n\n第二段。[1]\n\n\n第三段。')
    expect(inside(open(), '.op-para').map(gap => gap.textContent)).toEqual(['\n\n', '\n\n\n'])
    // The stylesheet lays the text out as it is written, and the gap as a block of its own.
    return import('../../src/client/styles.css?raw').then(({ default: css }) => {
      expect(css).toMatch(/\.op-dcard-text\s*\{[^}]*white-space:\s*pre-wrap/)
      expect(css).toMatch(/\.op-para\s*\{[^}]*display:\s*block/)
    })
  })
})

describe('update now', () => {
  const header = () => document.querySelector('.op-phead-actions')!
  const updateButton = () => find('立即更新', '.op-phead-actions button') as HTMLButtonElement
  const posts = (api: ReturnType<typeof stubApi>) => api.requests.filter(request => request.method === 'POST' && request.path === 'products/p1/update-now')

  it('update-now starts a run and shows it is running', async () => {
    let status: RunStatus = 'running'
    let reads = 0
    const api = stubApi({
      'GET products/:id': () => { reads++; return view() }, 'GET products/:id/findings': noFindings,
      'POST products/:id/update-now': { runId: 'r9' },
      'GET runs': () => ({ runs: [run('r0', 'p2', 'done'), run('r9', 'p1', status)] }),
    })
    const context = await mount(<Product />, { state: shellState, route: route() })
    expect(updateButton().disabled).toBe(false)
    await click(updateButton())
    // One request; the button says it is running, and cannot be pressed again meanwhile.
    expect(posts(api)).toHaveLength(1)
    expect(header().textContent).toContain('更新中…')
    expect(header().textContent).not.toContain('立即更新')
    expect((find('更新中…', '.op-phead-actions button') as HTMLButtonElement).disabled).toBe(true)
    // The run is asked about until it is over.
    await advance(2000)
    expect(header().textContent).toContain('更新中…')
    const before = reads
    status = 'done'
    await advance(2000)
    expect(updateButton().disabled).toBe(false)
    expect(header().textContent).not.toContain('更新中…')
    // The page reads the product again and the column's state follows.
    expect(reads).toBeGreaterThan(before)
    expect(context.refresh).toHaveBeenCalled()
    expect(document.querySelector('.op-product [role="alert"]')).toBeNull()
    expect(posts(api)).toHaveLength(1)
  })

  it('says why a run failed, or did not run', async () => {
    let status: RunStatus = 'failed'
    let note: string | null = '额度不足'
    stubApi({
      'GET products/:id': view(), 'GET products/:id/findings': noFindings, 'POST products/:id/update-now': { runId: 'r9' },
      'GET runs': () => ({ runs: [run('r9', 'p1', status, { error: note })] }),
    })
    await mount(<Product />, { state: shellState, route: route() })
    await click(updateButton())
    await advance(2000)
    expect(document.querySelector('.op-phead-error')?.textContent).toBe('这次更新没有成功：额度不足')
    expect(document.querySelector('.op-phead-error')?.getAttribute('role')).toBe('alert')
    expect(updateButton().disabled).toBe(false)
    // Pressing it again clears the old message.
    status = 'skipped'; note = '今日总预算已用完'
    await click(updateButton())
    await advance(2000)
    expect(document.querySelector('.op-phead-error')?.textContent).toBe('这次没有更新：今日总预算已用完')
    // A run that finished with a remark (done, with a note) is not an error.
    status = 'done'; note = '有 1 个来源打不开'
    await click(updateButton())
    await advance(2000)
    expect(document.querySelector('.op-phead-error')).toBeNull()
  })

  it('says when the update cannot be started', async () => {
    const api = stubApi({ 'GET products/:id': view(), 'GET products/:id/findings': noFindings, 'POST products/:id/update-now': fail(409, '这个产品没有在跟踪，先恢复跟踪再更新') })
    await mount(<Product />, { state: shellState, route: route() })
    await click(updateButton())
    expect(document.querySelector('.op-phead-error')?.textContent).toBe('这个产品没有在跟踪，先恢复跟踪再更新')
    expect(updateButton().disabled).toBe(false)
    expect(posts(api)).toHaveLength(1)
    // No run is asked about.
    expect(api.requests.some(request => request.path === 'runs')).toBe(false)
  })

  it('shows 更新中… while the product is being baselined, without a run of its own to wait for', async () => {
    await show(view({ product: { ...doubao, status: 'baselining' }, progress: { done: 1, total: 6 } }))
    expect(header().textContent).toContain('更新中…')
    expect((find('更新中…', '.op-phead-actions button') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the ⋯ menu', () => {
  const more = () => find('更多操作')
  const items = () => all('[role="menuitem"]').map(item => item.textContent)
  const patches = (api: ReturnType<typeof stubApi>) => api.requests.filter(request => request.method === 'PATCH').map(request => [request.path, request.body])

  it('pauses tracking, and resumes it', async () => {
    const { api, context } = await show()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(more().getAttribute('aria-haspopup')).toBe('menu')
    expect(more().getAttribute('aria-expanded')).toBe('false')
    await click(more())
    expect(more().getAttribute('aria-expanded')).toBe('true')
    expect(items()).toEqual(['暂停跟踪', '每日预算：不限'])
    await click(control('暂停跟踪'))
    expect(patches(api)).toEqual([['products/p1', { status: 'paused' }]])
    // The menu closes, and the page and the column read the change.
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(context.refresh).toHaveBeenCalled()
    unmount()
    const paused = await show(view({ product: { ...doubao, status: 'paused', dailyBudgetYuan: 2.5 } }))
    await click(more())
    expect(items()).toEqual(['恢复跟踪', '每日预算：¥2.5'])
    await click(control('恢复跟踪'))
    expect(patches(paused.api)).toEqual([['products/p1', { status: 'tracking' }]])
  })

  it('offers neither pausing nor resuming while the product is being baselined', async () => {
    await show(view({ product: { ...doubao, status: 'baselining' } }))
    await click(more())
    expect(items()).toEqual(['每日预算：不限'])
  })

  it('sets the daily budget of the product, and clears it', async () => {
    const { api } = await show(view({ product: { ...doubao, dailyBudgetYuan: 3 } }))
    await click(more())
    await click(control('每日预算：¥3'))
    const input = document.querySelector<HTMLInputElement>('[role="menu"] input')!
    expect(input.type).toBe('number')
    expect(input.value).toBe('3')
    expect(input.getAttribute('aria-label')).toBe('这个产品每天最多花（元）')
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('留空表示这个产品不单独设上限')
    await type(input, '2.5')
    await click('保存')
    expect(patches(api)).toEqual([['products/p1', { dailyBudgetYuan: 2.5 }]])
    expect(document.querySelector('[role="menu"]')).toBeNull()
    // Empty means no limit of its own: null.
    await click(more())
    await click(control('每日预算：¥3'))
    await type(document.querySelector('[role="menu"] input')!, '')
    await click('保存')
    expect(patches(api).at(-1)).toEqual(['products/p1', { dailyBudgetYuan: null }])
  })

  it('does not send a budget that is not a number from 0 up', async () => {
    const { api } = await show()
    await click(more())
    await click(control('每日预算：不限'))
    for (const bad of ['-1', '100001']) {
      await type(document.querySelector('[role="menu"] input')!, bad)
      await click('保存')
      expect(document.querySelector('[role="menu"] [role="alert"]')?.textContent).toBe('请填 0 到 100000 之间的数字，留空表示不限')
    }
    expect(patches(api)).toEqual([])
    // Zero is a number: the product may spend nothing.
    await type(document.querySelector('[role="menu"] input')!, '0')
    await click('保存')
    expect(patches(api)).toEqual([['products/p1', { dailyBudgetYuan: 0 }]])
  })

  it('shows the server’s answer when a change is refused', async () => {
    await show(view(), {}, { 'PATCH products/:id': fail(409, '建档完成后才能暂停或恢复跟踪') })
    await click(more())
    await click(control('暂停跟踪'))
    expect(document.querySelector('.op-product [role="alert"]')?.textContent).toBe('建档完成后才能暂停或恢复跟踪')
  })

  it('closes with Escape, giving the focus back, and with a click elsewhere', async () => {
    await show()
    await click(more())
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(more())
    await click(more())
    await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    // The arrow keys move between its entries.
    await click(more())
    const first = document.activeElement!
    await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(document.activeElement).not.toBe(first)
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
  })
})

describe('the feed tab', () => {
  const findings: Finding[] = [
    finding('f1', 'p1', { headline: '安卓全量开放', createdAt: '2026-11-25T08:05:00.000Z', dimensions: ['positioning'], sourceIds: ['s3'] }),
    finding('f3', 'p1', { headline: '老消息', createdAt: '2026-11-10T08:05:00.000Z', importance: 'minor' }),
    finding('f2', 'p1', { headline: '传闻接入电商', createdAt: '2026-11-22T08:05:00.000Z', status: 'unconfirmed', statusNote: '只有一个来源', dimensions: ['business'] }),
    finding('f4', 'p1', { headline: '没等到证实', createdAt: '2026-11-05T08:05:00.000Z', status: 'unproven', statusNote: '原文打不开' }),
    finding('f5', 'p1', { headline: '转正了', createdAt: '2026-11-20T08:05:00.000Z', statusNote: '已证实', verifiedOn: '2026-11-21' }),
  ]
  const feed = (extra: Record<string, unknown> = {}, shell: Partial<Shell> = {}) =>
    show(view(), { route: route({ tab: 'feed' }), ...shell }, { 'GET products/:id/findings': { findings, sources: [sources[2]!] }, 'POST followup': { sessionId: 's-1' }, ...extra })
  const headlines = () => all('.op-feed .op-card-title').map(title => title.textContent)
  const feedCard = (headline: string) => all('.op-feed .op-card').find(card => card.querySelector('.op-card-title')?.textContent === headline)!

  it('lists every finding of the product, newest first, as the brief’s cards', async () => {
    await feed()
    expect(headlines()).toEqual(['安卓全量开放', '传闻接入电商', '转正了', '老消息'])
    // The card is the brief's: the product, why, the source chip and the way to ask more.
    const first = feedCard('安卓全量开放')
    expect(first.querySelector('.op-card-product')?.textContent).toBe('豆包·小豆')
    expect(first.querySelector('.op-card-why')?.textContent).toBe('为什么值得注意：原因 f1')
    expect(first.querySelector('.op-source')?.textContent).toContain('豆包')
    expect(first.querySelector('.op-card-changed')?.textContent).toBe('改了档案：定位')
    // The brief's read marks do not apply here: nothing fades, and being seen marks nothing.
    expect(all('.op-feed .op-card[data-read]')).toHaveLength(0)
    expect(FakeObserver.all.every(observer => observer.targets.size === 0)).toBe(true)
  })

  it('shows an unconfirmed finding with its note, and tags a promotion 已证实', async () => {
    await feed()
    const waiting = feedCard('传闻接入电商')
    expect(tags(waiting, 'unconfirmed').map(tag => tag.textContent)).toEqual(['待确认'])
    expect(waiting.querySelector('.op-card-note')?.textContent).toBe('只有一个来源')
    expect(waiting.querySelector('.op-card-changed')).toBeNull()
    expect(tags(feedCard('转正了'), 'promoted').map(tag => tag.textContent)).toEqual(['已证实'])
    expect(tags(feedCard('老消息'), 'promoted')).toHaveLength(0)
  })

  it('folds the findings that went unproven under 已过期未证实的 n 条', async () => {
    await feed()
    const fold = control('已过期未证实的 1 条')
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(text()).not.toContain('没等到证实')
    await click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(headlines()).toEqual(['安卓全量开放', '传闻接入电商', '转正了', '老消息', '没等到证实'])
    const old = feedCard('没等到证实')
    expect(old.querySelector('.op-card-status')?.textContent).toContain('未证实')
    expect(old.querySelector('.op-card-status')?.textContent).toContain('原文打不开')
    await click(control('收起 ↑'))
    expect(text()).not.toContain('没等到证实')
  })

  it('leaves the fold out when nothing went unproven, and says so when there is nothing at all', async () => {
    await feed({ 'GET products/:id/findings': { findings: findings.filter(f => f.status !== 'unproven'), sources: [] } })
    expect(all('.op-fold')).toHaveLength(0)
    unmount()
    await feed({ 'GET products/:id/findings': { findings: [], sources: [] } })
    expect(text()).toContain('这个产品还没有发现')
  })

  it('opens the changed dimension on the profile from 看改动 →, and asks more from a finding', async () => {
    const opened = vi.fn()
    const sessions = { catalog: { list: { getSnapshot: () => ({ phase: 'ready', byId: { 's-1': {} } }) }, refresh: vi.fn() }, open: opened }
    const { api, context } = await feed({}, { sessions: sessions as never })
    await click(feedCard('安卓全量开放').querySelector<HTMLElement>('.op-card-actions button')!)
    expect(context.navigate).toHaveBeenCalledWith({ page: 'product', productId: 'p1', tab: 'dossier', expand: 'positioning' })
    await click([...feedCard('老消息').querySelectorAll<HTMLElement>('button')].find(button => button.textContent === '追问')!)
    expect(api.requests.filter(request => request.path === 'followup').map(request => request.body)).toEqual([{ findingId: 'f3' }])
    expect(opened).toHaveBeenCalledWith('s-1')
  })

  it('names the dimensions a finding changed by the labels of the product’s dimensions', async () => {
    await feed()
    expect(feedCard('传闻接入电商').querySelector('.op-card-changed')).toBeNull()
    // Verified and changing 商业化: its label, not its key.
    unmount()
    await feed({ 'GET products/:id/findings': { findings: [finding('f9', 'p1', { headline: '开始收费', dimensions: ['business', 'positioning'] })], sources: [] } })
    expect(feedCard('开始收费').querySelector('.op-card-changed')?.textContent).toBe('改了档案：商业化、定位')
  })
})

describe('the sources tab', () => {
  const list = () => all('.op-sources tbody tr')
  const cells = (row: Element) => [...row.querySelectorAll('td')].map(cell => cell.textContent)

  it('lists the sources, the most cited first and then the newest', async () => {
    // s1 is cited by four conclusions, s4 by three; s2 and s3 by one each (by 定位), s3 the newer: s2 has no date.
    await show(view(), { route: route({ tab: 'sources' }) })
    const rows = list()
    expect(rows.map(row => row.querySelector('a')?.textContent)).toEqual(['官方发布会', '用户评价合集', '官方公众号', '官网产品页'])
    // Title (a link to the page), publisher, date, type, and how many conclusions cite it.
    const first = rows[0]!
    expect(first.querySelector('a')?.getAttribute('href')).toBe('https://example.com/s1')
    expect(first.querySelector('a')?.getAttribute('target')).toBe('_blank')
    expect(cells(first)).toEqual(['官方发布会官方', '字节跳动', '2026-09-16', '官方发布', '被 4 条结论引用定位、目标人群、价值场景、关键技术'])
    expect(tags(first, 'official')).toHaveLength(1)
    expect(cells(rows[1]!)).toEqual(['用户评价合集', '某社区', '2026-11-10', '评测', '被 3 条结论引用目标人群、价值场景、体验'])
    expect(tags(rows[1]!, 'official')).toHaveLength(0)
    expect(cells(rows[3]!)[2]).toBe('—')
    // 来源 n counts them.
    expect(control('来源4').getAttribute('aria-selected')).toBe('true')
  })

  it('sorts by how many conclusions cite a source before its date', async () => {
    // s2: two citations, an old date; s3: one citation, a new one.
    await show(view({
      cards: [card('p1', 'positioning', { sourceIds: ['s2', 's3'] }), card('p1', 'audience', { sourceIds: ['s2'] })], sources: [sources[2]!, sources[1]!],
    }), { route: route({ tab: 'sources' }) })
    expect(list().map(row => cells(row)[0])).toEqual(['官网产品页官方', '官方公众号官方'])
    expect(cells(list()[0]!)[4]).toBe('被 2 条结论引用定位、目标人群')
  })

  it('says what a source that could not be opened was, and shows nothing when there are none', async () => {
    await show(view({ sources: [source('s4', { openedVia: 'unopened', title: '公众号文章', publisher: '某号' })], cards: [card('p1', 'positioning', { sourceIds: ['s4'] })] }), { route: route({ tab: 'sources' }) })
    expect(tags(list()[0]!, 'unopened').map(tag => tag.textContent)).toEqual(['原文打不开'])
    unmount()
    await show(view({ sources: [], cards: [] }), { route: route({ tab: 'sources' }) })
    expect(list()).toHaveLength(0)
    expect(text()).toContain('还没有来源')
  })
})

describe('inside the shell', () => {
  it('opens the card a finding points to, from the feed, on the same page', async () => {
    const changing = finding('f1', 'p1', { headline: '安卓全量开放', dimensions: ['audience'] })
    stubApi({ 'GET state': shellState, 'GET products/:id': view(), 'GET products/:id/findings': { findings: [changing], sources: [] } })
    localStorage.setItem('outpost.route', JSON.stringify({ page: 'product', productId: 'p1', tab: 'feed' }))
    await mount(<App t={t} />)
    expect(dcards()).toHaveLength(0)
    await click(find('看改动 →'))
    // The profile, with that card open and in view; the route remembers the tab only.
    expect(expanded()).toEqual(['目标人群'])
    expect(scrollIntoView.mock.contexts).toEqual([dcard('目标人群')])
    expect(JSON.parse(localStorage.getItem('outpost.route')!)).toEqual({ page: 'product', productId: 'p1', tab: 'dossier' })
  })

  it('opens the product page on the card the route names, and moves between its tabs', async () => {
    stubApi({
      'GET state': shellState, 'GET products/:id': view(), 'GET products/:id/findings': noFindings,
    })
    localStorage.setItem('outpost.route', JSON.stringify({ page: 'product', productId: 'p1', tab: 'dossier' }))
    await mount(<App t={t} />)
    expect(document.querySelector('.op-content h1')?.textContent).toBe('豆包·小豆')
    expect(dcards()).toHaveLength(6)
    await click(control('来源4'))
    expect(list_().length).toBe(4)
    expect(JSON.parse(localStorage.getItem('outpost.route')!)).toEqual({ page: 'product', productId: 'p1', tab: 'sources' })
    await click(control('档案'))
    expect(dcards()).toHaveLength(6)
    // Another product is another page: the first one's cards are gone, not carried over.
    stubApi({
      'GET state': shellState, 'GET products/:id': productView(muse, { dimensions: [{ key: 'positioning', label: '定位' }] }), 'GET products/:id/findings': noFindings,
    })
    await click(all('.op-mid .op-row').find(row => row.querySelector('.op-row-label')?.textContent === 'Meta Muse')!)
    expect(document.querySelector('.op-content h1')?.textContent).toBe('Meta Muse')
    expect(dcards().map(item => item.querySelector('.op-dcard-name')?.textContent)).toEqual(['定位'])
    expect(dcard('定位').getAttribute('data-state')).toBe('empty')
  })
})
const list_ = () => all('.op-sources tbody tr')
