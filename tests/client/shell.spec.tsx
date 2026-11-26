// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, call, describeError, usePoll } from '../../src/client/api.ts'
import { App } from '../../src/client/shell/App.tsx'
import { MiddleColumn } from '../../src/client/shell/MiddleColumn.tsx'
import { parseRoute, useRoute } from '../../src/client/shell/route.ts'
import type { Candidate } from '../../src/core/types.ts'
import { all, click, fail, find, mount, product, settle, state, stubApi, t, text, track, tracked, unmount } from '../fixtures/client.tsx'

afterEach(() => {
  unmount()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
})

/** The middle column's row whose label is `name`, or undefined. */
const row = (name: string) => all('.op-mid .op-row').find(r => r.querySelector('.op-row-label')?.textContent === name)
const end = (name: string) => row(name)?.querySelector('.op-row-end')?.textContent
const pageTitle = () => document.querySelector('.op-content h1')?.textContent
const candidate = (id: string, extra: Partial<Candidate> = {}): Candidate => ({
  id, trackId: 't1', batchId: 'b1', productId: `p-${id}`, tier: 'strong', oneLiner: '', reason: '', selected: true,
  heat: { foundCount: 0, datedWeekly: [], trend: 'unknown', showBars: false }, ...extra,
})

describe('middle column', () => {
  it('lists tracks with their products and a blue dot for new findings', async () => {
    stubApi({ 'GET state': state({ todayUnread: 3, todayCostYuan: 4.23, tracks: [
      track('t1', 'Personal Agent', [tracked(product('p1', 'Meta Muse'), { hasNew: true }), tracked(product('p2', '豆包·小豆'))]),
      track('t2', 'AI 眼镜', [tracked(product('p3', 'Ray-Ban Meta'))]),
    ] }) })
    await mount(<App t={t} />)
    // Top: the title with 「＋ 新赛道」, then today's brief with its count of new findings.
    expect(document.querySelector('.op-mid-title')?.textContent).toBe('前哨')
    expect(find('＋ 新赛道')).toBeTruthy()
    expect(end('今日哨报')).toBe('3 条新')
    // One group per track: its name and number of products, then its products in order.
    const groups = all('.op-group')
    expect(groups.map(g => [g.querySelector('.op-group-name')?.textContent, g.querySelector('.op-group-end')?.textContent]))
      .toEqual([['Personal Agent', '2'], ['AI 眼镜', '1']])
    expect([...groups[0]!.querySelectorAll('.op-row-label')].map(label => label.textContent)).toEqual(['Meta Muse', '豆包·小豆'])
    // The blue dot marks the product with new findings, and only it.
    expect(row('Meta Muse')!.querySelector('.op-dot')).not.toBeNull()
    expect(row('豆包·小豆')!.querySelector('.op-dot')).toBeNull()
    expect(row('Ray-Ban Meta')!.querySelector('.op-dot')).toBeNull()
    // Each product row leads with its icon.
    expect(row('Meta Muse')!.querySelector('.op-icon')?.textContent).toBe('M')
    // Bottom: the runs with today's spend, and settings.
    expect(end('运行记录')).toBe('今天 ¥4.2')
    expect(row('设置')).toBeDefined()
    expect(document.querySelector('.op-mid-foot')?.contains(row('运行记录')!)).toBe(true)

    // Today's brief is the page shown first; choosing a product selects it (blue, no bar) and opens its page.
    expect(row('今日哨报')!.getAttribute('aria-current')).toBe('page')
    await click(row('豆包·小豆')!)
    expect(row('豆包·小豆')!.getAttribute('aria-current')).toBe('page')
    expect(row('今日哨报')!.getAttribute('aria-current')).toBeNull()
    expect(pageTitle()).toBe('豆包·小豆')
    // A group folds away and opens again from its header.
    const head = groups[0]!.querySelector<HTMLElement>('.op-group-head')!
    expect(head.getAttribute('aria-expanded')).toBe('true')
    await click(head)
    expect(head.getAttribute('aria-expanded')).toBe('false')
    expect(row('Meta Muse')).toBeUndefined()
    expect(row('Ray-Ban Meta')).toBeDefined()
    await click(head)
    expect(row('Meta Muse')).toBeDefined()
  })

  it('does not show 赛道概览 · 对比矩阵 in M1', async () => {
    stubApi({ 'GET state': state({ tracks: [track('t1', 'Personal Agent', [tracked(product('p1', 'Meta Muse'))], {}, 2)] }) })
    await mount(<App t={t} />)
    expect(row('Meta Muse')).toBeDefined()
    expect(text()).not.toContain('对比矩阵')
    expect(text()).not.toContain('赛道概览')
  })

  it('shows picking, baselining and waiting candidates as each track stands', async () => {
    const api = stubApi({
      'GET state': state({ tracks: [
        track('t1', 'Personal Agent', [], { status: 'picking' }, 4),
        track('t2', 'AI 眼镜', [
          tracked(product('p1', 'Rokid', { status: 'baselining' }), { progress: { done: 2, total: 6 } }),
          tracked(product('p2', '雷鸟', { status: 'baselining' })),
          tracked(product('p3', 'Ray-Ban Meta', { status: 'paused' })),
        ], {}, 3),
      ] }),
      // Strong candidates start picked; an excluded one never counts.
      'GET tracks/:id/candidates': {
        batchId: 'b1', running: true, status: 'running', error: null, elapsedSec: 30,
        candidates: [candidate('a'), candidate('b'), candidate('c', { tier: 'consider', selected: false }), candidate('d', { tier: 'excluded', selected: true })]
          .map(c => ({ ...c, product: product(c.productId, c.id) })),
      },
    })
    await mount(<App t={t} />)
    // A track being picked says so, and offers its 挑产品 page with the count picked (no product rows yet).
    const picking = all('.op-group')[0]!
    expect(picking.querySelector('.op-group-end')?.textContent).toBe('挑选中')
    expect(end('挑产品')).toBe('已选 2')
    expect(api.requests.find(r => r.path === 'tracks/t1/candidates')).toBeDefined()
    expect(picking.textContent).not.toContain('候选推荐')
    // Products being baselined say 建档中, with the progress when one is known; a paused one says so.
    expect(end('Rokid')).toBe('建档中 2/6')
    expect(end('雷鸟')).toBe('建档中')
    expect(end('Ray-Ban Meta')).toBe('已暂停')
    // Candidates waiting to be looked at.
    expect(end('候选推荐')).toBe('3 条待看')
    // Both lead to the track's 挑产品 page, selected in the column.
    await click(row('挑产品')!)
    expect(row('挑产品')!.getAttribute('aria-current')).toBe('page')
    // The track's own picking page (its name is the title), not the blank form.
    expect(pageTitle()).toBe('Personal Agent')
    await click(row('候选推荐')!)
    expect(row('候选推荐')!.getAttribute('aria-current')).toBe('page')
    expect(row('挑产品')!.getAttribute('aria-current')).toBeNull()
  })

  it('counts the picks the 挑产品 page reports instead of the defaults', async () => {
    const api = stubApi({})
    await mount(<MiddleColumn />, { state: state({ tracks: [track('t1', 'Personal Agent', [], { status: 'picking' })] }), picks: { t1: 5 } })
    expect(end('挑产品')).toBe('已选 5')
    expect(api.requests).toHaveLength(0)
  })

  it('reads a track\'s candidates every 2 s while the recommendation runs, and only every 30 s after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let running = true
    const api = stubApi({
      'GET tracks/:id/candidates': () => ({ batchId: 'b1', running, status: running ? 'running' : 'done', error: null, elapsedSec: 5, candidates: [{ ...candidate('a'), product: product('p-a', 'a') }] }),
    })
    await mount(<MiddleColumn />, { state: state({ tracks: [track('t1', 'Personal Agent', [], { status: 'picking' })] }) })
    const reads = () => api.requests.filter(r => r.path === 'tracks/t1/candidates').length
    const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
    // While it runs, the candidates arrive and the count follows.
    const first = reads()
    await advance(6000)
    expect(reads() - first).toBe(3)
    expect(end('挑产品')).toBe('已选 1')
    // Once it is over, the column does not keep asking every 2 s for a list that no longer changes.
    running = false
    await advance(2000)
    const over = reads()
    await advance(20_000)
    expect(reads()).toBe(over)
    await advance(10_000)
    expect(reads()).toBe(over + 1)
  })

  it('reads the state every 5 s while a track is only being picked, and every 2 s while a recommendation runs or a baseline is in progress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let recommending = false
    let progress: { done: number; total: number } | null = null
    const api = stubApi({
      'GET state': () => state({ tracks: [
        { ...track('t1', 'Personal Agent', [], { status: 'picking' }), recommending },
        track('t2', 'AI 眼镜', [tracked(product('p1', 'Rokid', { status: 'baselining' }), { progress })]),
      ] }),
      'GET tracks/:id/candidates': { batchId: 'b1', running: false, status: 'done', error: null, elapsedSec: 5, candidates: [] },
    })
    await mount(<App t={t} />)
    const reads = () => api.requests.filter(r => r.path === 'state').length
    const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
    // A track that is picking, with nothing running for it: the quiet pace (a track left in 挑选中 for days must not poll every 2 s).
    const first = reads()
    await advance(4000)
    expect(reads()).toBe(first)
    await advance(1000)
    expect(reads()).toBe(first + 1)
    await advance(10_000)
    expect(reads()).toBe(first + 3)

    // Its recommendation starts: the next read sees it, reads again at once, and then every 2 s.
    recommending = true
    await advance(5000)
    const fast = reads()
    await advance(6000)
    expect(reads() - fast).toBe(3)

    // Over: back to the quiet pace (the wait already begun may still be a short one).
    recommending = false
    await advance(2000)
    await advance(2000)
    const settled = reads()
    await advance(4000)
    expect(reads() - settled).toBeLessThanOrEqual(1)
    await advance(20_000)
    expect(reads() - settled).toBeLessThanOrEqual(5)

    // A baseline in progress is quick, as before.
    progress = { done: 1, total: 6 }
    await advance(5000)
    const baselining = reads()
    await advance(6000)
    expect(reads() - baselining).toBe(3)
  })

  it('says 前哨正在启动… until the plugin answers, then shows its tracks', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    stubApi({ 'GET state': fail(404) }) // the DSH web server's empty 404 while the plugin's routes are not mounted yet
    await mount(<App t={t} />)
    expect(document.querySelector('.op-mid-note')?.textContent).toBe('前哨正在启动…')
    // Never a blank panel: the column keeps its entries and the right column its page.
    expect(row('今日哨报')).toBeDefined()
    expect(row('设置')).toBeDefined()
    expect(pageTitle()).toBe('今日哨报')
    // It keeps asking; once the plugin answers, the note gives way to the tracks.
    stubApi({ 'GET state': state({ tracks: [track('t1', 'Personal Agent', [tracked(product('p1', 'Meta Muse'))])] }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    await settle()
    expect(document.querySelector('.op-mid-note')).toBeNull()
    expect(row('Meta Muse')).toBeDefined()
  })

  it('shows the server’s error when reading the state fails', async () => {
    stubApi({ 'GET state': fail(500, '前哨内部出错，详情见 DSH 日志') })
    await mount(<App t={t} />)
    expect(document.querySelector('.op-mid-note')?.textContent).toBe('前哨内部出错，详情见 DSH 日志')
  })

  it('greets a first run with the essentials and a button to the first track', async () => {
    stubApi({ 'GET state': state() })
    await mount(<App t={t} />)
    // The column: 前哨 with 「＋ 新赛道」, 今日哨报 (none yet), then 运行记录 and 设置; no groups, no spend.
    expect(all('.op-group')).toHaveLength(0)
    expect(all('.op-mid .op-row-label').map(label => label.textContent)).toEqual(['今日哨报', '运行记录', '设置'])
    expect(end('今日哨报')).toBe('还没有')
    expect(end('运行记录')).toBeUndefined()
    // The right column welcomes, and its button starts the first track.
    expect(document.querySelector('.op-welcome h1')?.textContent).toBe('先建一个赛道')
    await click('＋ 新建第一个赛道')
    expect(pageTitle()).toBe('新建赛道')
    expect(document.querySelector('.op-welcome')).toBeNull()
  })

  it('opens the column from a toggle when the panel is narrow, and closes it after a choice', async () => {
    stubApi({ 'GET state': state() })
    await mount(<App t={t} />)
    const app = document.querySelector<HTMLElement>('.op-app')!
    const toggle = find('前哨菜单')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(app.hasAttribute('data-nav-open')).toBe(false)
    await click(toggle)
    expect(app.hasAttribute('data-nav-open')).toBe(true)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await click(row('设置')!)
    expect(app.hasAttribute('data-nav-open')).toBe(false)
    expect(pageTitle()).toBe('设置')
  })
})

describe('routing', () => {
  it('restores the last route and survives a throwing localStorage', async () => {
    stubApi({ 'GET state': state({ tracks: [track('t1', 'Personal Agent', [tracked(product('p1', 'Meta Muse'))])] }) })
    localStorage.setItem('outpost.route', JSON.stringify({ page: 'settings' }))
    await mount(<App t={t} />)
    expect(row('设置')!.getAttribute('aria-current')).toBe('page')
    expect(pageTitle()).toBe('设置')
    // Each move is remembered for the next visit.
    await click(row('运行记录')!)
    expect(pageTitle()).toBe('运行记录')
    expect(JSON.parse(localStorage.getItem('outpost.route')!)).toEqual({ page: 'runs' })
    unmount()

    // Something unreadable, or a route that names no page, starts on today's brief.
    for (const stored of ['{not json', JSON.stringify({ page: 'product' }), JSON.stringify({ page: 'matrix' })]) {
      localStorage.setItem('outpost.route', stored)
      await mount(<App t={t} />)
      expect(pageTitle()).toBe('今日哨报')
      unmount()
    }

    // A storage that throws on every access (blocked site data): the panel still opens and still moves.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError') } })
    try {
      await mount(<App t={t} />)
      expect(row('今日哨报')!.getAttribute('aria-current')).toBe('page')
      await click(row('设置')!)
      expect(row('设置')!.getAttribute('aria-current')).toBe('page')
      expect(pageTitle()).toBe('设置')
    } finally {
      Object.defineProperty(globalThis, 'localStorage', original)
    }
  })

  it('restores a product page with its tab', async () => {
    stubApi({ 'GET state': state({ tracks: [track('t1', 'Personal Agent', [tracked(product('p1', 'Meta Muse'))])] }) })
    localStorage.setItem('outpost.route', JSON.stringify({ page: 'product', productId: 'p1', tab: 'sources' }))
    await mount(<App t={t} />)
    expect(row('Meta Muse')!.getAttribute('aria-current')).toBe('page')
    expect(pageTitle()).toBe('Meta Muse')
    // The tab comes back as stored; one the page does not have falls back to the dossier; a product needs its id.
    expect(parseRoute({ page: 'product', productId: 'p1', tab: 'sources', expand: 'pricing' })).toEqual({ page: 'product', productId: 'p1', tab: 'sources', expand: 'pricing' })
    expect(parseRoute({ page: 'product', productId: 'p1', tab: 'topics' })).toEqual({ page: 'product', productId: 'p1', tab: 'dossier' })
    expect(parseRoute({ page: 'product', tab: 'feed' })).toBeUndefined()
    expect(parseRoute({ page: 'today', date: '2026-11-24' })).toEqual({ page: 'today', date: '2026-11-24' })
    expect(parseRoute({ page: 'newTrack', trackId: 't1', extra: 1 })).toEqual({ page: 'newTrack', trackId: 't1' })
    // Moving away and back is remembered each time; choosing the product from the column opens its dossier.
    await click(row('今日哨报')!)
    expect(JSON.parse(localStorage.getItem('outpost.route')!)).toEqual({ page: 'today' })
    await click(row('Meta Muse')!)
    expect(JSON.parse(localStorage.getItem('outpost.route')!)).toEqual({ page: 'product', productId: 'p1', tab: 'dossier' })
  })

  it('remembers a page without the brief’s day or the card a link asked to open', async () => {
    let current: ReturnType<typeof useRoute> | undefined
    function Probe() { current = useRoute(); return null }
    await mount(<Probe />)
    expect(current![0]).toEqual({ page: 'today' })
    await act(async () => { current![1]({ page: 'today', date: '2026-11-24' }) })
    // The page shows that day now, but the next visit opens on today's.
    expect(current![0]).toEqual({ page: 'today', date: '2026-11-24' })
    expect(JSON.parse(localStorage.getItem('outpost.route')!)).toEqual({ page: 'today' })
    await act(async () => { current![1]({ page: 'product', productId: 'p1', tab: 'dossier', expand: 'pricing' }) })
    expect(current![0]).toEqual({ page: 'product', productId: 'p1', tab: 'dossier', expand: 'pricing' })
    expect(JSON.parse(localStorage.getItem('outpost.route')!)).toEqual({ page: 'product', productId: 'p1', tab: 'dossier' })
  })
})

describe('api client', () => {
  it('polls at its interval, keeps the last answer through a failure, and reads again on reload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let unread = 1
    let down = false
    const api = stubApi({ 'GET state': () => down ? fail(500, '前哨内部出错，详情见 DSH 日志') : state({ todayUnread: unread }) })
    let seen: ReturnType<typeof usePoll<Awaited<ReturnType<typeof call<'GET state'>>>>> | undefined
    function Probe() {
      seen = usePoll(() => call('GET state'), [], 5000)
      return null
    }
    await mount(<Probe />)
    expect(seen!.data?.todayUnread).toBe(1)
    expect(api.requests).toHaveLength(1)
    // Every 5 s.
    unread = 2
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await settle()
    expect(seen!.data?.todayUnread).toBe(2)
    expect(api.requests).toHaveLength(2)
    // A failure keeps what was read, with the error beside it; the next answer clears the error.
    down = true
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    await settle()
    expect(seen!.data?.todayUnread).toBe(2)
    expect(seen!.error?.message).toBe('前哨内部出错，详情见 DSH 日志')
    // reload reads at once (what the shell's refresh does after a change such as 全部已读).
    down = false
    unread = 0
    await act(async () => { await seen!.reload() })
    await settle()
    expect(api.requests).toHaveLength(4)
    expect(seen!.data?.todayUnread).toBe(0)
    expect(seen!.error).toBeUndefined()
  })

  it('sends JSON content-type on every change, even without a body', async () => {
    const api = stubApi({
      'POST findings/:id/read': { ok: true },
      'POST products/:id/update-now': { runId: 'r1' },
      'PATCH tracks/:id': track('t1', '眼镜', []).track,
      'GET state': state(),
      'GET brief': { brief: null, findings: [], products: [], sources: [], changed: {}, prevDate: null },
    })
    expect(await call('POST findings/:id/read', { id: 'f 1/2' })).toEqual({ ok: true })
    expect(await call('POST products/:id/update-now', { id: 'p1' })).toEqual({ runId: 'r1' })
    await call('PATCH tracks/:id', { id: 't1', body: { name: '眼镜' } })
    await call('GET state')
    await call('GET brief', { query: { date: '2026-11-24' } })
    expect(api.requests.map(r => [r.method, r.path, r.headers['content-type'], r.body])).toEqual([
      ['POST', 'findings/f%201%2F2/read', 'application/json', undefined],
      ['POST', 'products/p1/update-now', 'application/json', undefined],
      ['PATCH', 'tracks/t1', 'application/json', { name: '眼镜' }],
      ['GET', 'state', undefined, undefined],
      ['GET', 'brief', undefined, undefined],
    ])
    expect(api.requests[0]!.params).toEqual({ id: 'f 1/2' })
    expect(api.requests[4]!.query).toEqual({ date: '2026-11-24' })
  })

  it('fails with the server’s sentence, and tells a plugin still starting from a refusal', async () => {
    stubApi({ 'POST tracks/:id/recommend': fail(409, '上一轮推荐还在进行，稍等它结束再调整') })
    const refused = await call('POST tracks/:id/recommend', { id: 't1' }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(ApiError)
    expect(refused).toMatchObject({ status: 409, message: '上一轮推荐还在进行，稍等它结束再调整', starting: false })
    // An empty 404 is the web server before the plugin mounts its routes; a thrown fetch is a host that does not answer.
    stubApi({ 'GET state': fail(404) })
    expect(await call('GET state').catch((error: unknown) => error)).toMatchObject({ status: 404, starting: true })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    expect(await call('GET state').catch((error: unknown) => error)).toMatchObject({ status: 0, starting: true })
  })

  /** A `fetch` that never answers until its signal aborts, as a hung connection; `timeouts` are the clocks `AbortSignal.timeout` handed out. */
  function hungFetch() {
    const timeouts: AbortController[] = []
    const asked = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => { const controller = new AbortController(); timeouts.push(controller); return controller.signal })
    const fetch = vi.fn((_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(init.signal!.reason) })
    }))
    vi.stubGlobal('fetch', fetch)
    return { timeouts, asked, fetch }
  }
  const timedOut = () => new DOMException('The operation timed out.', 'TimeoutError')

  it('gives up on a request nobody answers after 30 s, and says 请求超时', async () => {
    const { timeouts, asked } = hungFetch()
    const pending = call('GET state').catch((error: unknown) => error)
    await settle()
    expect(asked).toHaveBeenCalledWith(30_000)
    expect(timeouts).toHaveLength(1)
    timeouts[0]!.abort(timedOut())
    const error = await pending
    expect(error).toBeInstanceOf(ApiError)
    // Not 「前哨正在启动…」: the plugin may be there, it did not answer in time.
    expect(error).toMatchObject({ status: 0, starting: false, timedOut: true })
    expect(describeError(t, error as ApiError)).toBe('请求超时')
  })

  it('does not report the caller\'s own abort as a timeout', async () => {
    hungFetch()
    const caller = new AbortController()
    const pending = call('GET state', undefined, { signal: caller.signal }).catch((error: unknown) => error)
    await settle()
    caller.abort()
    const error = await pending
    expect(error).not.toBeInstanceOf(ApiError)
    expect((error as Error).name).toBe('AbortError')
  })

  it('lets a poll go on after a request timed out, instead of stalling the queue behind it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const { timeouts, fetch } = hungFetch()
    let seen: ReturnType<typeof usePoll<Awaited<ReturnType<typeof call<'GET state'>>>>> | undefined
    function Probe() {
      seen = usePoll(() => call('GET state'), [], 5000)
      return null
    }
    await mount(<Probe />)
    expect(fetch).toHaveBeenCalledTimes(1)
    // The first read hangs; nothing else is asked while it does (one request at a time)…
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(fetch).toHaveBeenCalledTimes(1)
    // …until its clock runs out: the poll reports it and reads again at its pace.
    fetch.mockImplementation(async () => Response.json(state({ todayUnread: 3 })))
    await act(async () => { timeouts[0]!.abort(timedOut()) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(seen!.data?.todayUnread).toBe(3)
    expect(seen!.error).toBeUndefined()
  })
})
