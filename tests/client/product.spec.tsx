// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Dimension, Finding, Product as ProductRecord, RunStatus, Source, Span } from '../../src/core/types.ts'
import type { ProductView } from '../../src/host/api.ts'
import { Product } from '../../src/client/pages/Product.tsx'
import { App } from '../../src/client/shell/App.tsx'
import type { Route } from '../../src/client/shell/route.ts'
import type { Shell } from '../../src/client/shell/context.ts'
import { all, card, click, facts, fail, finding, find, mount, product, productView, run, settle, source, state, stubApi, t, tEn, text, track, tracked, type, unmount } from '../fixtures/client.tsx'

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
const noFindings = { findings: [] as Finding[], sources: [] as Source[], changed: {} }

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

  it('has the tabs 档案, 动态 and 来源 with their counts, and 专题 (M2.3)', async () => {
    const f = [finding('f1', 'p1'), finding('f2', 'p1', { status: 'unconfirmed', statusNote: '只有一个来源' }), finding('f3', 'p1', { status: 'unproven', statusNote: '只有一个来源' })]
    const { context } = await show(view(), {}, { 'GET products/:id/findings': { findings: f, sources: [] } })
    const tabs = all('[role="tab"]')
    // 动态 counts what the tab lists open: the unproven one is folded away and has its own count there.
    expect(tabs.map(tab => tab.textContent)).toEqual(['档案', '动态2', '来源4', '专题'])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false'])
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
    expect(all('[role="tab"]').map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false'])
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
    // Nothing checks the key facts, and they cite nothing: the strip says so.
    const unchecked = document.querySelector<HTMLElement>('.op-facts-note .op-tag')!
    expect([unchecked.dataset.kind, unchecked.textContent]).toEqual(['unchecked', 'AI 整理 · 未核查'])
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

  it('fills the width with a grid of cards from 300px, at most three to a row (design §5.4: three wide, two narrow)', async () => {
    await show()
    // jsdom does not lay anything out: the rule itself is what the stylesheet must say. A column is never narrower than
    // 300px nor narrower than a third of the row (less the two 12px gaps), so a wide screen gets three columns that fill
    // it, not four with the last row half empty.
    const css = (await import('../../src/client/styles.css?raw')).default
    expect(css).toMatch(/\.op-dgrid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(max\(300px,\s*calc\(\(100% - 24px\) \/ 3\)\),\s*1fr\)\)/)
    expect(css).toMatch(/\.op-dcard\[data-expanded\]\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/)
    expect(css).not.toMatch(/border-left|border-inline-start/)
  })

  it('shows — for a fact it does not have, and leaves the positioning line out without a positioning card', async () => {
    await show(view({ facts: facts('p1', { platforms: '', rivals: [] }), cards: cards.slice(1) }))
    expect(all('.op-fact').map(fact => fact.querySelector('.op-fact-v')?.textContent)).toEqual(['App 内代理', '—', '免费', '2026-09', '—'])
    expect(document.querySelector('.op-positioning')).toBeNull()
    unmount()
    // No facts at all: every one is —, and the strip stays, with nothing to call unchecked.
    await show(view({ facts: null }))
    expect(all('.op-fact').map(fact => fact.querySelector('.op-fact-v')?.textContent)).toEqual(['—', '—', '—', '—', '—'])
    expect(document.querySelector('.op-facts-note')).toBeNull()
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

  describe('a dimension that none of the product’s tracks lists', () => {
    const PRICING = { key: 'pricing', label: '定价' }
    const LISTED = DIMENSIONS.slice(0, 2)
    /** Cards and history of two listed dimensions and of 定价, which was only in a track the product left. */
    const withPricing = (dimensions: Dimension[], extra: Partial<ProductView> = {}) => view({
      dimensions,
      cards: [...cards.slice(0, 2), card('p1', 'pricing', { bullets: ['按次收费'], body: '按次收费，不订阅。', createdAt: ago(0.5) })],
      history: { ...history, pricing: [{ version: 1, changeNote: '建档', createdAt: nov(18) }] },
      ...extra,
    })
    const names = () => dcards().map(item => item.querySelector('.op-dcard-name')?.textContent)

    it('keeps its cards and history out of the profile, and shows them again once a track lists it', async () => {
      await show(withPricing(LISTED))
      expect(names()).toEqual(['定位', '目标人群'])
      expect(text()).not.toContain('按次收费')
      expect(text()).not.toContain('pricing')
      // The product joins a track that lists it again: the card is back, under that track's label.
      unmount()
      await show(withPricing([...LISTED, PRICING]))
      expect(names()).toEqual(['定位', '目标人群', '定价'])
      expect(dcard('定价').textContent).toContain('按次收费')
    })

    it('leaves it out of 全部展开, and of the histories that open with the cards', async () => {
      await show(withPricing(LISTED))
      await click('全部展开')
      expect(expanded()).toEqual(['定位', '目标人群'])
      // Every card there is to open is open: the button says so, though a hidden card is not.
      expect(all('button').some(button => button.textContent === '全部收起')).toBe(true)
      expect(all('.op-history')).toHaveLength(2)
      expect(text()).not.toContain('按次收费')
      await click('全部收起')
      expect(expanded()).toEqual([])
    })

    it('offers 全部展开 while a listed card is closed, whatever the hidden ones are', async () => {
      await show(withPricing(LISTED), { route: route({ expand: 'positioning' }) })
      expect(all('.op-phead-actions button').map(button => button.textContent)).toContain('全部展开')
      await click(dcard('目标人群').querySelector('button')!)
      expect(all('.op-phead-actions button').map(button => button.textContent)).toContain('全部收起')
    })

    it('falls back to the profile for a link to its card: nothing opens, nothing scrolls, nothing breaks', async () => {
      await show(withPricing(LISTED), { route: route({ expand: 'pricing' }) })
      expect(names()).toEqual(['定位', '目标人群'])
      expect(expanded()).toEqual([])
      expect(scrollIntoView).not.toHaveBeenCalled()
      expect(all('.op-dcard-open')).toHaveLength(0)
      expect(document.querySelector('.op-product [role="alert"]')).toBeNull()
    })

    it('does not take its time for the time the profile was last updated', async () => {
      // 定价 was written half an hour ago, after the card shown last: the header speaks of what is on the page.
      await show(withPricing(LISTED, { cards: [card('p1', 'positioning', { createdAt: nov(20) }), card('p1', 'pricing', { createdAt: ago(0.5) })] }))
      expect(document.querySelector('.op-phead-meta')?.textContent).toBe('字节跳动 · 11-18 建档 · 11-20 更新')
    })

    it('leaves the positioning sentence out when no track lists 定位 any more', async () => {
      await show(withPricing([LISTED[1]!, PRICING]))
      expect(names()).toEqual(['目标人群', '定价'])
      expect(document.querySelector('.op-positioning')).toBeNull()
    })
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
      const para = /\.op-para\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
      expect(para).toMatch(/display:\s*block/)
      // A visible gap: a height, which `em` takes from the element's own font size, so that size may not be 0 (the gap would be 0px).
      expect(para).toMatch(/height:\s*[\d.]+(em|px|rem)/)
      if (/font-size:\s*0(?![.\d])/.test(para)) expect(para).not.toMatch(/height:[^;]*[\d.]em\b/)
      expect(para).not.toMatch(/font-size:\s*0(?![.\d])/)
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
    expect(items()).toEqual(['暂停跟踪', '每日预算：不限', '编辑名称和官网…', '移到其他赛道…', '也加到其他赛道…', '删除产品…'])
    await click(control('暂停跟踪'))
    expect(patches(api)).toEqual([['products/p1', { status: 'paused' }]])
    // The menu closes, and the page and the column read the change.
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(context.refresh).toHaveBeenCalled()
    unmount()
    const paused = await show(view({ product: { ...doubao, status: 'paused', dailyBudgetYuan: 2.5 } }))
    await click(more())
    expect(items()).toEqual(['恢复跟踪', '每日预算：¥2.5', '编辑名称和官网…', '移到其他赛道…', '也加到其他赛道…', '删除产品…'])
    await click(control('恢复跟踪'))
    expect(patches(paused.api)).toEqual([['products/p1', { status: 'tracking' }]])
  })

  it('offers neither pausing nor resuming while the product is being baselined', async () => {
    await show(view({ product: { ...doubao, status: 'baselining' } }))
    await click(more())
    expect(items()).toEqual(['每日预算：不限', '编辑名称和官网…', '移到其他赛道…', '也加到其他赛道…', '删除产品…'])
  })

  it('edits the name, company and official sites in the menu (M1.5)', async () => {
    const { api } = await show(view({ product: { ...doubao, officialDomains: ['doubao.com'] } }))
    await click(more())
    await click(control('编辑名称和官网…'))
    const [name, company, site] = all<HTMLInputElement>('[role="menu"] input')
    expect([name!.value, company!.value, site!.value]).toEqual(['豆包·小豆', '字节跳动', 'doubao.com'])
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('以后的调研、核查都用新名字')
    await type(name!, ' 小豆 ')
    await type(site!, 'doubao.com， https://www.xiaodou.cn ')
    await click('保存')
    expect(patches(api)).toEqual([['products/p1', { name: '小豆', company: '字节跳动', officialDomains: ['doubao.com', 'https://www.xiaodou.cn'] }]])
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it('does not send an empty name, and says a refusal of the host in the menu', async () => {
    const { api } = await show(view(), {}, { 'PATCH products/:id': fail(409, '已经有一个「Meta Muse」在跟踪了。想合并的话，删掉其中一个') })
    await click(more())
    await click(control('编辑名称和官网…'))
    const [name] = all<HTMLInputElement>('[role="menu"] input')
    await type(name!, '  ')
    await click('保存')
    expect(patches(api)).toEqual([])
    expect(document.querySelector('[role="menu"] [role="alert"]')?.textContent).toBe('请填名称')
    await type(name!, 'Meta Muse')
    await click('保存')
    expect(document.querySelector('[role="menu"] [role="alert"]')?.textContent).toBe('已经有一个「Meta Muse」在跟踪了。想合并的话，删掉其中一个')
  })

  it('puts the focus back on the entry after 取消 in the name form and in the question (review 4)', async () => {
    await show()
    await click(more())
    await click(control('编辑名称和官网…'))
    await click(find('取消', '[role="menu"] button'))
    expect(document.activeElement).toBe(control('编辑名称和官网…'))
    await click(control('删除产品…'))
    await click(find('取消', '[role="menu"] button'))
    expect(document.activeElement).toBe(control('删除产品…'))
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
  })

  it('deletes the product after asking once more, and goes to the brief (M1.5)', async () => {
    const { api, context } = await show(view(), {}, { 'POST products/:id/delete': { ok: true } })
    await click(more())
    await click(control('删除产品…'))
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('删除「豆包·小豆」？档案、发现和它在哨报里的条目都会删掉，不能恢复。花费记录保留。')
    expect(api.requests.filter(request => request.method === 'POST')).toEqual([])
    await click(find('删除', '[role="menu"] button'))
    expect(api.requests.filter(request => request.method === 'POST').map(request => request.path)).toEqual(['products/p1/delete'])
    expect(context.refresh).toHaveBeenCalled()
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'today' })
  })

  it('says, in English too, why a product cannot be deleted yet', async () => {
    const { context } = await show(view(), { t: tEn }, { 'POST products/:id/delete': fail(409, '「豆包·小豆」正在建档、更新或核查，等它跑完再删') })
    await click(find('More actions'))
    await click(control('Delete product…'))
    await click(find('Delete', '[role="menu"] button'))
    expect(document.querySelector('[role="menu"] [role="alert"]')?.textContent).toBe('“豆包·小豆” is being profiled, updated or checked; delete it once that is over')
    expect(context.navigate).not.toHaveBeenCalledWith({ page: 'today' })
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

describe('the ⋯ menu, by keyboard', () => {
  const more = () => find('更多操作')
  const press = async (target: Element, key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => { target.dispatchEvent(event) })
    return event
  }

  it('leaves the arrow keys to the budget field, and walks the entries only from an entry', async () => {
    await show()
    await click(more())
    await click(control('每日预算：不限'))
    const input = document.querySelector<HTMLInputElement>('[role="menu"] input')!
    input.focus()
    for (const key of ['ArrowDown', 'ArrowUp']) {
      const event = await press(input, key)
      // Not taken by the menu: the browser's own step in a number field still happens, and the focus stays in it.
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(input)
    }
    // From an entry they do walk, and the key is taken.
    const item = control('暂停跟踪')
    item.focus()
    const event = await press(item, 'ArrowDown')
    expect(event.defaultPrevented).toBe(true)
  })

  it('takes Escape only while the menu is open', async () => {
    await show()
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    try {
      // Closed: Escape on the button goes on to whoever listens above (it is not swallowed, nor does the button take focus).
      more().focus()
      await press(more(), 'Escape')
      expect(seen).toHaveBeenCalledTimes(1)
      expect(document.querySelector('[role="menu"]')).toBeNull()
      // Open: the menu takes it and closes, and nobody above sees it.
      await click(more())
      seen.mockClear()
      await press(document.activeElement!, 'Escape')
      expect(seen).not.toHaveBeenCalled()
      expect(document.querySelector('[role="menu"]')).toBeNull()
      expect(document.activeElement).toBe(more())
    } finally {
      document.removeEventListener('keydown', seen)
    }
  })

  it('puts the focus back on the budget entry after 取消', async () => {
    await show()
    await click(more())
    await click(control('每日预算：不限'))
    expect(document.querySelector('[role="menu"] input')).not.toBeNull()
    await click('取消')
    expect(document.querySelector('[role="menu"] input')).toBeNull()
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
    expect(document.activeElement?.textContent).toBe('每日预算：不限')
    // The menu is still open, and the entry can be opened again.
    await click(document.activeElement!)
    expect(document.querySelector('[role="menu"] input')).not.toBeNull()
  })
})

describe('the ⋯ menu, tracks', () => {
  const more = () => find('更多操作')
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]')
  const items = () => all('[role="menuitem"]').map(item => item.textContent)
  /** The entries of the open list of tracks. */
  const options = () => all('[role="menu"] [role="group"] [role="menuitem"]').map(item => item.textContent)
  const alert = () => document.querySelector('[role="menu"] [role="alert"]')?.textContent
  const result = () => document.querySelector('[role="menu"] [role="status"]')?.textContent
  /** The track requests sent so far (what is not a read, nor the pause or budget change). */
  const sent = (api: ReturnType<typeof stubApi>) => api.requests.filter(request => request.method === 'POST' && /^products\/p1\/(link|unlink|move)$/.test(request.path)).map(request => [request.path, request.body])
  const reads = (api: ReturnType<typeof stubApi>) => api.requests.filter(request => request.method === 'GET' && request.path === 'products/p1').length
  const press = async (target: Element, key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => { target.dispatchEvent(event) })
    return event
  }

  const mine = tracked(doubao)
  /** 小豆 is in 「Personal Agent」 alone; 「手机 AI 助理」 and the one still being picked are free; 「旧赛道」 is archived. */
  const alone = state({ tracks: [
    track('t1', 'Personal Agent', [mine, tracked(muse)], { dimensions: DIMENSIONS }),
    track('t2', '手机 AI 助理', [tracked(muse)], { dimensions: DIMENSIONS }),
    track('t3', 'AI 硬件', [], { dimensions: DIMENSIONS, status: 'picking' }),
    track('t4', '旧赛道', [], { dimensions: DIMENSIONS, status: 'archived' }),
  ] })
  /** In two of them, with one left to add it to. */
  const twice = state({ tracks: [
    track('t1', 'Personal Agent', [mine, tracked(muse)], { dimensions: DIMENSIONS }),
    track('t2', '手机 AI 助理', [mine], { dimensions: DIMENSIONS }),
    track('t3', 'AI 硬件', [], { dimensions: DIMENSIONS }),
  ] })
  const MOVED = { 'POST products/:id/move': { toppedUp: 1 }, 'POST products/:id/link': { toppedUp: 2 }, 'POST products/:id/unlink': { ok: true } }

  it('offers move only when the product is in one track, and remove per track when in several', async () => {
    await show(view(), { state: alone }, MOVED)
    await click(more())
    expect(items()).toEqual(['暂停跟踪', '每日预算：不限', '编辑名称和官网…', '移到其他赛道…', '也加到其他赛道…', '删除产品…'])
    expect(all('[role="menuitem"]').map(item => item.getAttribute('aria-expanded'))).toEqual([null, null, null, 'false', 'false', null])
    unmount()
    await show(view(), { state: twice }, MOVED)
    await click(more())
    // Moving is moving out of the one track it is in; with several it is taking it out of one, so that is what is offered.
    expect(items()).toEqual(['暂停跟踪', '每日预算：不限', '编辑名称和官网…', '也加到其他赛道…', '从「Personal Agent」拿掉', '从「手机 AI 助理」拿掉', '删除产品…'])
  })

  it('offers no track entry when the page does not know the product’s tracks', async () => {
    // The state is not read yet, or does not have the product in any track (it is not followed): nothing to move or remove.
    await show(view(), { state: undefined }, MOVED)
    await click(more())
    expect(items()).toEqual(['暂停跟踪', '每日预算：不限', '编辑名称和官网…', '删除产品…'])
    unmount()
    await show(view(), { state: state({ tracks: [track('t1', 'Personal Agent', [tracked(muse)], { dimensions: DIMENSIONS }), track('t2', '手机 AI 助理', [], { dimensions: DIMENSIONS })] }) }, MOVED)
    await click(more())
    expect(items()).toEqual(['暂停跟踪', '每日预算：不限', '编辑名称和官网…', '删除产品…'])
  })

  it('move lists the other active tracks and reports the result', async () => {
    const { api, context } = await show(view(), { state: alone }, MOVED)
    await click(more())
    const entry = control('移到其他赛道…')
    await click(entry)
    // The product's own track and the archived one are not there; the one still being picked is.
    expect(entry.getAttribute('aria-expanded')).toBe('true')
    expect(options()).toEqual(['手机 AI 助理', 'AI 硬件'])
    expect(entry.getAttribute('aria-controls')).toBe(document.querySelector('[role="menu"] [role="group"]')!.id)
    expect(document.querySelector('[role="menu"] [role="group"]')!.getAttribute('aria-labelledby')).toBe(entry.id)
    // The focus is on the first of them, ready for the arrow keys.
    expect(document.activeElement?.textContent).toBe('手机 AI 助理')
    const before = reads(api)
    await click(control('手机 AI 助理'))
    expect(sent(api)).toEqual([['products/p1/move', { from: 't1', to: 't2' }]])
    // The menu stays open to say what was done; the page and the column read the change.
    expect(menu()).not.toBeNull()
    expect(result()).toBe('已移到「手机 AI 助理」 · 补 1 张卡')
    expect(alert()).toBeUndefined()
    expect(document.querySelector('[role="menu"] [role="group"]')).toBeNull()
    expect(reads(api)).toBeGreaterThan(before)
    expect(context.refresh).toHaveBeenCalled()
    // The focus did not fall to the page: it is back on the entry that opened the list.
    expect(document.activeElement).toBe(control('移到其他赛道…'))
  })

  it('leaves 补 n 张卡 out when no card was added', async () => {
    await show(view(), { state: alone }, { ...MOVED, 'POST products/:id/move': { toppedUp: 0 } })
    await click(more())
    await click(control('移到其他赛道…'))
    await click(control('AI 硬件'))
    expect(result()).toBe('已移到「AI 硬件」')
  })

  it('also-add keeps the product where it is', async () => {
    const { api } = await show(view(), { state: alone }, MOVED)
    await click(more())
    await click(control('也加到其他赛道…'))
    expect(options()).toEqual(['手机 AI 助理', 'AI 硬件'])
    await click(control('AI 硬件'))
    // A link and nothing else: no move, no leaving the track it is in.
    expect(sent(api)).toEqual([['products/p1/link', { trackId: 't3' }]])
    expect(result()).toBe('已加到「AI 硬件」 · 补 2 张卡')
    expect(menu()).not.toBeNull()
    expect(document.activeElement).toBe(control('也加到其他赛道…'))
  })

  it('opens one list at a time, and a second press on its entry folds it away', async () => {
    await show(view(), { state: alone }, MOVED)
    await click(more())
    await click(control('移到其他赛道…'))
    expect(options()).toHaveLength(2)
    await click(control('也加到其他赛道…'))
    expect(control('移到其他赛道…').getAttribute('aria-expanded')).toBe('false')
    expect(control('也加到其他赛道…').getAttribute('aria-expanded')).toBe('true')
    expect(all('[role="menu"] [role="group"]')).toHaveLength(1)
    // Folded away by its own entry, the focus stays on it.
    await click(control('也加到其他赛道…'))
    expect(all('[role="menu"] [role="group"]')).toHaveLength(0)
    expect(document.activeElement).toBe(control('也加到其他赛道…'))
    // Opening the daily budget does not leave a list open under it.
    await click(control('移到其他赛道…'))
    await click(control('每日预算：不限'))
    expect(all('[role="menu"] [role="group"]')).toHaveLength(0)
  })

  it('takes the product out of one track, and closes the menu with the focus back on ⋯', async () => {
    const { api, context } = await show(view(), { state: twice }, MOVED)
    await click(more())
    await click(control('从「Personal Agent」拿掉'))
    expect(sent(api)).toEqual([['products/p1/unlink', { trackId: 't1' }]])
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(more())
    expect(context.refresh).toHaveBeenCalled()
  })

  it('shows 还没有别的赛道 when there is nowhere to go', async () => {
    const stuck = state({ tracks: [track('t1', 'Personal Agent', [mine], { dimensions: DIMENSIONS }), track('t4', '旧赛道', [], { dimensions: DIMENSIONS, status: 'archived' })] })
    const { api } = await show(view(), { state: stuck }, MOVED)
    await click(more())
    expect(items()).toEqual(['暂停跟踪', '每日预算：不限', '编辑名称和官网…', '移到其他赛道…', '也加到其他赛道…', '删除产品…'])
    for (const name of ['移到其他赛道…', '也加到其他赛道…']) {
      const entry = control(name)
      expect(entry.getAttribute('aria-disabled'), name).toBe('true')
      // Said once, and attached to both entries as their description.
      const hint = document.getElementById(entry.getAttribute('aria-describedby')!)
      expect(hint?.textContent, name).toBe('还没有别的赛道')
      await click(entry)
      expect(entry.getAttribute('aria-expanded'), name).toBe('false')
    }
    expect(all('[role="menu"] .op-menu-note')).toHaveLength(1)
    expect(all('[role="menu"] [role="group"]')).toHaveLength(0)
    expect(sent(api)).toEqual([])
    // A disabled entry is still one the arrow keys reach, so that a reader of the screen hears why it cannot be used.
    control('编辑名称和官网…').focus()
    await press(document.activeElement!, 'ArrowDown')
    expect(document.activeElement).toBe(control('移到其他赛道…'))
    // In several tracks, with every other one joined, only 也加到 is out of use; taking it out of a track still is not.
    unmount()
    const full = state({ tracks: [track('t1', 'Personal Agent', [mine], { dimensions: DIMENSIONS }), track('t2', '手机 AI 助理', [mine], { dimensions: DIMENSIONS })] })
    await show(view(), { state: full }, MOVED)
    await click(more())
    expect(items()).toEqual(['暂停跟踪', '每日预算：不限', '编辑名称和官网…', '也加到其他赛道…', '从「Personal Agent」拿掉', '从「手机 AI 助理」拿掉', '删除产品…'])
    expect(control('也加到其他赛道…').getAttribute('aria-disabled')).toBe('true')
    expect(control('从「手机 AI 助理」拿掉').getAttribute('aria-disabled')).toBeNull()
    expect(all('[role="menu"] .op-menu-note').map(note => note.textContent)).toEqual(['还没有别的赛道'])
  })

  it('a refused change is said inside the menu', async () => {
    // The page thinks the product is in two tracks; the host knows better (the other one was archived since).
    const only = '这是它唯一的赛道。不想跟了就用「暂停跟踪」。'
    await show(view(), { state: twice }, { ...MOVED, 'POST products/:id/unlink': fail(409, only) })
    await click(more())
    await click(control('从「Personal Agent」拿掉'))
    // The server's own words, in the menu, which stays open with the product where it was.
    expect(alert()).toBe(only)
    expect(menu()).not.toBeNull()
    expect(result()).toBeUndefined()
    unmount()
    // A move or an add refused leaves the list open, to pick another; the next one that goes through clears the note.
    let answers = [fail(409, '这个赛道已归档'), { toppedUp: 0 }]
    const { api } = await show(view(), { state: alone }, { ...MOVED, 'POST products/:id/move': () => answers.shift() })
    await click(more())
    await click(control('移到其他赛道…'))
    await click(control('手机 AI 助理'))
    expect(alert()).toBe('这个赛道已归档')
    expect(menu()).not.toBeNull()
    expect(options()).toEqual(['手机 AI 助理', 'AI 硬件'])
    expect(result()).toBeUndefined()
    await click(control('AI 硬件'))
    expect(alert()).toBeUndefined()
    expect(result()).toBe('已移到「AI 硬件」')
    expect(sent(api).map(([, body]) => body)).toEqual([{ from: 't1', to: 't2' }, { from: 't1', to: 't3' }])
    // 它已经在这个赛道里了 and the like for an add.
    unmount()
    await show(view(), { state: alone }, { ...MOVED, 'POST products/:id/link': fail(409, '它已经在这个赛道里了') })
    await click(more())
    await click(control('也加到其他赛道…'))
    await click(control('手机 AI 助理'))
    expect(alert()).toBe('它已经在这个赛道里了')
  })

  it('sends a change once however often its entry is pressed', async () => {
    let release = () => {}
    const slow = new Promise<{ toppedUp: number }>(resolve => { release = () => { resolve({ toppedUp: 0 }) } })
    const { api } = await show(view(), { state: alone }, { ...MOVED, 'POST products/:id/move': () => slow })
    await click(more())
    await click(control('移到其他赛道…'))
    const target = control('手机 AI 助理')
    await act(async () => { target.click(); target.click() })
    await act(async () => { control('AI 硬件').click() })
    expect(sent(api)).toEqual([['products/p1/move', { from: 't1', to: 't2' }]])
    await act(async () => { release() })
    await settle()
    expect(result()).toBe('已移到「手机 AI 助理」')
  })

  it('clears the last result when the budget editor opens', async () => {
    await show(view(), { state: alone }, MOVED)
    await click(more())
    await click(control('移到其他赛道…'))
    await click(control('手机 AI 助理'))
    expect(result()).toBe('已移到「手机 AI 助理」 · 补 1 张卡')
    await click(control('每日预算：不限'))
    expect(result()).toBeUndefined()
    expect(document.querySelector('[role="menu"] input')).not.toBeNull()
  })

  it('cuts a long track name in 从「X」拿掉 short, and keeps the whole of it as the tooltip', async () => {
    const long = '一个名字非常非常长的赛道，长到一行放不下'
    const crowded = state({ tracks: [track('t1', long, [mine], { dimensions: DIMENSIONS }), track('t2', '手机 AI 助理', [mine], { dimensions: DIMENSIONS })] })
    await show(view(), { state: crowded }, MOVED)
    await click(more())
    const entry = control(`从「${long}」拿掉`)
    expect(entry.title).toBe(long)
    expect(entry.classList.contains('op-menu-clip')).toBe(true)
    // The rule that cuts it is in the stylesheet, and the entries of the lists are cut by the same one.
    const css = (await import('../../src/client/styles.css?raw')).default
    expect(css).toMatch(/\.op-menu-clip\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/)
  })

  it('says nothing, and takes no focus, when the menu was closed while the change was on its way', async () => {
    let release = () => {}
    const slow = new Promise<{ toppedUp: number }>(resolve => { release = () => { resolve({ toppedUp: 1 }) } })
    const { api } = await show(view(), { state: alone }, { ...MOVED, 'POST products/:id/move': () => slow })
    await click(more())
    await click(control('移到其他赛道…'))
    await act(async () => { control('手机 AI 助理').click() })
    // The reader moves on: Escape closes the menu, and the focus goes to something else.
    await press(document.activeElement!, 'Escape')
    const elsewhere = find('立即更新')
    elsewhere.focus()
    await act(async () => { release() })
    await settle()
    // The move was made all the same; the menu, opened again, is as it was at first, and the focus was not taken.
    expect(sent(api)).toEqual([['products/p1/move', { from: 't1', to: 't2' }]])
    expect(document.activeElement).toBe(elsewhere)
    await click(more())
    expect(result()).toBeUndefined()
    expect(options()).toEqual([])
  })

  it('keyboard: arrows walk the track list, Escape closes and returns focus to ⋯', async () => {
    const { api } = await show(view(), { state: alone }, MOVED)
    await click(more())
    // ArrowRight on the entry opens its list, with the focus on the first track.
    control('移到其他赛道…').focus()
    const right = await press(document.activeElement!, 'ArrowRight')
    expect(right.defaultPrevented).toBe(true)
    expect(options()).toEqual(['手机 AI 助理', 'AI 硬件'])
    expect(document.activeElement?.textContent).toBe('手机 AI 助理')
    // The arrows walk the tracks, and on from the last one to the entry after the list, and round again.
    await press(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('AI 硬件')
    await press(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('也加到其他赛道…')
    await press(document.activeElement!, 'ArrowUp')
    expect(document.activeElement?.textContent).toBe('AI 硬件')
    await press(document.activeElement!, 'ArrowUp')
    await press(document.activeElement!, 'ArrowUp')
    expect(document.activeElement?.textContent).toBe('移到其他赛道…')
    // ArrowLeft from a track folds the list away and goes back to its entry.
    await press(document.activeElement!, 'ArrowRight')
    await press(document.activeElement!, 'ArrowDown')
    expect(document.activeElement?.textContent).toBe('AI 硬件')
    await press(document.activeElement!, 'ArrowLeft')
    expect(options()).toEqual([])
    expect(document.activeElement).toBe(control('移到其他赛道…'))
    // Nothing was sent by walking about; Escape from inside the list closes the whole menu and gives the focus back.
    await press(document.activeElement!, 'ArrowRight')
    const escape = await press(document.activeElement!, 'Escape')
    expect(escape.defaultPrevented).toBe(false)
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(more())
    expect(sent(api)).toEqual([])
    // Opened again, the menu is as it was at first: the list closed, the old answer gone.
    await click(more())
    expect(options()).toEqual([])
    expect(result()).toBeUndefined()
  })

  it('goes on to the page: the column and the menu follow the state the move leaves behind', async () => {
    // The shell's own state is read again after the move: the product is now in the other track, and the menu offers what is left.
    let moved = false
    const after = state({ tracks: [track('t1', 'Personal Agent', [tracked(muse)], { dimensions: DIMENSIONS }), track('t2', '手机 AI 助理', [mine, tracked(muse)], { dimensions: DIMENSIONS })] })
    stubApi({
      'GET state': () => moved ? after : state({ tracks: [track('t1', 'Personal Agent', [mine, tracked(muse)], { dimensions: DIMENSIONS }), track('t2', '手机 AI 助理', [tracked(muse)], { dimensions: DIMENSIONS })] }),
      'GET products/:id': view(), 'GET products/:id/findings': noFindings,
      'POST products/:id/move': () => { moved = true; return { toppedUp: 0 } },
    })
    localStorage.setItem('outpost.route', JSON.stringify({ page: 'product', productId: 'p1', tab: 'dossier' }))
    await mount(<App t={t} />)
    const rowsOf = (name: string) => [...all('.op-mid .op-group').find(group => group.getAttribute('aria-label') === name)!.querySelectorAll('.op-row-label')]
      .map(label => label.textContent).filter(label => label !== '＋ 添加产品' && label !== '赛道概览')
    expect(rowsOf('Personal Agent')).toEqual(['豆包·小豆', 'Meta Muse'])
    await click(find('更多操作'))
    await click(control('移到其他赛道…'))
    await click(control('手机 AI 助理'))
    expect(result()).toBe('已移到「手机 AI 助理」')
    await settle()
    expect(rowsOf('Personal Agent')).toEqual(['Meta Muse'])
    expect(rowsOf('手机 AI 助理')).toEqual(['豆包·小豆', 'Meta Muse'])
    // Now it is in 手机 AI 助理 alone: the way back is a move to the first.
    expect(items()).toEqual(['暂停跟踪', '每日预算：不限', '编辑名称和官网…', '移到其他赛道…', '也加到其他赛道…', '删除产品…'])
    await click(control('移到其他赛道…'))
    expect(options()).toEqual(['Personal Agent'])
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
    show(view(), { route: route({ tab: 'feed' }), ...shell }, { 'GET products/:id/findings': { findings, sources: [sources[2]!], changed: { f1: ['positioning'], f2: ['business'] } }, 'POST followup': { sessionId: 's-1' }, ...extra })
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

  it('names every track the product is in on its cards, in the track list’s order', async () => {
    // 小豆 is in two tracks (the second listed first); Muse's track is not one of them.
    const twoTracks = state({ tracks: [
      track('t2', '手机 AI 助理', [tracked(doubao)], { dimensions: DIMENSIONS }),
      track('t3', 'AI 硬件', [tracked(muse)], { dimensions: DIMENSIONS }),
      track('t1', 'Personal Agent', [tracked(muse), tracked(doubao)], { dimensions: DIMENSIONS }),
    ] })
    await feed({}, { state: twoTracks })
    for (const headline of ['安卓全量开放', '传闻接入电商', '老消息'])
      expect(feedCard(headline).querySelector('.op-card-track')?.textContent, headline).toBe('· 手机 AI 助理、Personal Agent')
    // In one track only: that one.
    unmount()
    await feed()
    expect(feedCard('安卓全量开放').querySelector('.op-card-track')?.textContent).toBe('· Personal Agent')
  })

  it('names the dimensions a finding changed by the labels of the product’s dimensions', async () => {
    await feed()
    expect(feedCard('传闻接入电商').querySelector('.op-card-changed')).toBeNull()
    // Verified and changing 商业化: its label, not its key.
    unmount()
    await feed({ 'GET products/:id/findings': { findings: [finding('f9', 'p1', { headline: '开始收费', dimensions: ['business', 'positioning', 'audience'] })], sources: [], changed: { f9: ['business', 'positioning'] } } })
    expect(feedCard('开始收费').querySelector('.op-card-changed')?.textContent).toBe('改了档案：商业化、定位')
    // What it names but did not change is not claimed.
    unmount()
    await feed({ 'GET products/:id/findings': { findings: [finding('f9', 'p1', { headline: '开始收费', dimensions: ['business'] })], sources: [], changed: {} } })
    expect(feedCard('开始收费').querySelector('.op-card-changed')).toBeNull()
    expect([...feedCard('开始收费').querySelectorAll('button')].map(button => button.textContent)).toEqual(['追问'])
  })

  it('does not name a dimension the profile no longer shows, nor offer 看改动 for it', async () => {
    const answer = (changed: string[]) => ({ 'GET products/:id/findings': { findings: [finding('f9', 'p1', { headline: '改了定价', dimensions: changed })], sources: [], changed: { f9: changed } } })
    // 定价 is a card the product keeps from a track it left: only the one the page shows is named, and 看改动 opens that one.
    const { context } = await feed(answer(['pricing', 'business']))
    expect(feedCard('改了定价').querySelector('.op-card-changed')?.textContent).toBe('改了档案：商业化')
    await click([...feedCard('改了定价').querySelectorAll<HTMLElement>('button')].find(button => button.textContent === '看改动 →')!)
    expect(context.navigate).toHaveBeenCalledWith({ page: 'product', productId: 'p1', tab: 'dossier', expand: 'business' })
    // Only the hidden one changed: nothing to look at.
    unmount()
    await feed(answer(['pricing']))
    expect(feedCard('改了定价').querySelector('.op-card-changed')).toBeNull()
    expect([...feedCard('改了定价').querySelectorAll('button')].map(button => button.textContent)).toEqual(['追问'])
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

  it('leaves out what only a hidden card cites, and never names a dimension by its key', async () => {
    // 定价 is a card of a track the product left, cited by s3 alone; s1 is cited by it as well as by two cards on the page.
    const hidden = card('p1', 'pricing', { sourceIds: ['s1', 's3'], bullets: ['按次收费'] })
    await show(view({
      dimensions: DIMENSIONS.slice(0, 2), cards: [card('p1', 'positioning', { sourceIds: ['s1', 's2'] }), card('p1', 'audience', { sourceIds: ['s1'] }), hidden],
      sources: [sources[0]!, sources[1]!, sources[2]!],
    }), { route: route({ tab: 'sources' }) })
    expect(list().map(row => row.querySelector('a')?.textContent)).toEqual(['官方发布会', '官网产品页'])
    // How many cite it, and which: the cards on the page only.
    expect(cells(list()[0]!)[4]).toBe('被 2 条结论引用定位、目标人群')
    expect(cells(list()[1]!)[4]).toBe('被 1 条结论引用定位')
    expect(text()).not.toContain('pricing')
    // 来源 n counts what is listed.
    expect(control('来源2').getAttribute('aria-selected')).toBe('true')
    // The product joins a track that lists it again: its sources are back, under that track's label.
    unmount()
    await show(view({
      dimensions: [...DIMENSIONS.slice(0, 2), { key: 'pricing', label: '定价' }], cards: [card('p1', 'positioning', { sourceIds: ['s1', 's2'] }), hidden],
      sources: [sources[0]!, sources[1]!, sources[2]!],
    }), { route: route({ tab: 'sources' }) })
    // One citation each for the other two: the newer first.
    expect(list().map(row => row.querySelector('a')?.textContent)).toEqual(['官方发布会', '官方公众号', '官网产品页'])
    expect(cells(list()[0]!)[4]).toBe('被 2 条结论引用定位、定价')
    expect(cells(list()[1]!)[4]).toBe('被 1 条结论引用定价')
    expect(control('来源3')).toBeDefined()
  })

  it('shows no 来源 count when only hidden cards cite anything', async () => {
    await show(view({ dimensions: DIMENSIONS.slice(0, 1), cards: [card('p1', 'pricing', { sourceIds: ['s1'] })], sources: [sources[0]!] }), { route: route({ tab: 'dossier' }) })
    expect(all('.op-tab-n')).toHaveLength(0)
    expect(control('来源').textContent).toBe('来源')
  })

  it('lists a page once however many cards cite it, naming each card that cites it once (M1.6)', async () => {
    // Each card keeps its own copy of what it cites: the same report, under three spellings of its address.
    const copies = [
      source('a1', { url: 'https://news.example/xd?utm_source=feed', title: '同一篇报道', openedVia: 'unopened', quoteFound: null }),
      source('a2', { url: 'https://www.news.example/xd', title: '同一篇报道' }),
      source('a3', { url: 'https://news.example/xd/', title: '同一篇报道' }),
      source('b1', { url: 'https://other.example/a', title: '另一篇' }),
    ]
    const cited = [card('p1', 'positioning', { sourceIds: ['a1', 'b1'] }), card('p1', 'audience', { sourceIds: ['a2', 'a3'] })]
    await show(view({ sources: copies, cards: cited }), { route: route({ tab: 'sources' }) })
    expect(list().map(row => row.querySelector('a')?.textContent)).toEqual(['同一篇报道', '另一篇'])
    expect(cells(list()[0]!)[4]).toBe('被 2 条结论引用定位、目标人群')
    expect(tags(list()[0]!, 'unopened')).toHaveLength(0) // another copy of it was opened
    expect(control('来源2').getAttribute('aria-selected')).toBe('true') // the tab counts pages
    unmount()
    // In English, the default dimensions that cite it are named in English too.
    await show(view({ sources: copies, cards: cited }), { route: route({ tab: 'sources' }), t: tEn })
    expect(cells(list()[0]!)[4]).toBe('Cited by 2 conclusionsPositioning, Audience')
  })

  it('calls a source official only when the check agreed, and says when it did not (M1.6)', async () => {
    const claimed = (id: string, title: string, officialConfirmed: boolean | null) => source(id, { title, kind: 'official', isOfficial: true, officialConfirmed })
    const three = [claimed('s1', '官网', true), claimed('s2', '同名公司', false), claimed('s3', '旧来源', null)]
    await show(view({ sources: three, cards: [card('p1', 'positioning', { sourceIds: ['s1', 's2', 's3'] })] }), { route: route({ tab: 'sources' }) })
    const kinds = () => list().map(row => row.querySelector('.op-sources-kind')?.textContent)
    expect(kinds()).toEqual(['官方发布', '不是官方', '官方（未核实）'])
    expect(list().map(row => tags(row, 'official').length)).toEqual([1, 0, 0])
    unmount()
    await show(view({ sources: three, cards: [card('p1', 'positioning', { sourceIds: ['s1', 's2', 's3'] })] }), { route: route({ tab: 'sources' }), t: tEn })
    expect(kinds()).toEqual(['Official', 'Not official', 'Official (not checked)'])
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
    const changing = finding('f1', 'p1', { headline: '安卓全量开放', dimensions: ['positioning', 'audience'] })
    stubApi({ 'GET state': shellState, 'GET products/:id': view(), 'GET products/:id/findings': { findings: [changing], sources: [], changed: { f1: ['audience'] } } })
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
