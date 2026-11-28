// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Axes, Dimension, Landscape } from '../../src/core/types.ts'
import type { TrackOverview } from '../../src/host/api.ts'
import { toCsv } from '../../src/client/csv.ts'
import { labelSpots, matrixRows, Track } from '../../src/client/pages/Track.tsx'
import { parseRoute } from '../../src/client/shell/route.ts'
import type { Shell } from '../../src/client/shell/context.ts'
import { all, card, click, find, mount, product, state, stubApi, t, tEn, text, track, type, unmount } from '../fixtures/client.tsx'

const DIMENSIONS: Dimension[] = [{ key: 'positioning', label: '定位' }, { key: 'business', label: '商业化' }, { key: 'custom-1', label: '记忆' }]
const AXES: Axes = { x: { low: '寄生在 App 里', high: '独立 App' }, y: { low: '陪聊问答', high: '替你办事' } }
const doubao = product('p1', '豆包·小豆'), muse = product('p2', 'Meta Muse', { status: 'paused' }), zed = product('p3', 'Zed', { status: 'baselining' })
const NOW = new Date()
const todayIso = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 9).toISOString()

const landscape = (over: Partial<Landscape> = {}): Landscape => ({
  id: 'l2', trackId: 't1', date: '2026-11-28', gist: '两条路线：小豆独立办事，Muse 寄生社交', axes: AXES,
  positions: [{ productId: 'p1', x: 60, y: 70, why: '独立 App，主打代办' }, { productId: 'p2', x: -50, y: -20, why: '住在 WhatsApp 里' }, { productId: 'gone', x: 0, y: 0, why: '' }],
  runId: 'r1', createdAt: '2026-11-28T01:00:00.000Z', ...over,
})
const overview = (over: Partial<TrackOverview> = {}): TrackOverview => ({
  track: track('t1', 'Personal Agent', [], { dimensions: DIMENSIONS, brief: '能替人办事的个人代理', createdAt: '2026-11-18T08:00:00.000Z' }).track,
  products: [
    { product: doubao, cards: [card('p1', 'positioning', { summary: '独立的个人代理' }), card('p1', 'business', { summary: '免费，三档订阅', version: 2, createdAt: todayIso })] },
    { product: muse, cards: [card('p2', 'positioning', { summary: '住在社交 App 里的助手' })] },
    { product: zed, cards: [] },
  ],
  landscape: landscape(), since: null, drawing: false, mappable: 2, unmapped: null,
  weekly: { on: true, last: '2026-11-26', next: '2026-12-03', running: false }, ...over,
})

async function show(view: TrackOverview | (() => TrackOverview) = overview(), shell: Partial<Shell> = {}, extra: Record<string, unknown> = {}) {
  const api = stubApi({ 'GET tracks/:id/overview': typeof view === 'function' ? view : () => view, 'POST tracks/:id/map': { ok: true }, ...extra })
  const context = await mount(<Track />, { state: state({ runTime: '08:00', tracks: [track('t1', 'Personal Agent', [])] }), route: { page: 'track', trackId: 't1' }, ...shell })
  return { api, context }
}
const cells = () => all('.op-matrix tbody tr').map(row => [...row.querySelectorAll('th, td')].map(cell => cell.textContent))
const sent = (api: ReturnType<typeof stubApi>) => api.requests.filter(request => request.method === 'POST').map(request => [request.path, request.body])

afterEach(() => { unmount(); vi.restoreAllMocks() })

describe('赛道页 (M2.1)', () => {
  it('names the track, what it follows and how it runs, with the 格局 as an AI summary', async () => {
    const { context } = await show()
    expect(document.querySelector('h1')?.textContent).toBe('Personal Agent')
    expect(document.querySelector('.op-thead-meta')?.textContent).toBe('跟踪 3 个 · 11-18 起 · 每天 08:00 · 关注：定位、商业化、记忆')
    expect(document.querySelector('.op-thead-brief')?.textContent).toBe('能替人办事的个人代理')
    expect(document.querySelector('.op-gist')?.textContent).toBe('AI 归纳两条路线：小豆独立办事，Muse 寄生社交')
    await click('赛道设置')
    expect(context.navigate).toHaveBeenCalledWith({ page: 'editTrack', trackId: 't1' })
  })

  it('lays the dossiers out as a table: a row per dimension, a column per product, today’s changes marked', async () => {
    const { context } = await show()
    expect(all('.op-matrix thead th').map(cell => cell.textContent)).toEqual(['维度', '豆豆包·小豆', 'MMeta Muse已暂停', 'ZZed建档中']) // icon, name, state
    expect(cells()).toEqual([
      ['定位', '独立的个人代理', '住在社交 App 里的助手', '建档中'],
      ['商业化', '免费，三档订阅今天', '—', '建档中'],
      ['记忆', '—', '—', '建档中'],
    ])
    expect(all('.op-matrix td[data-today]').map(cell => cell.textContent)).toEqual(['免费，三档订阅今天'])
    // A cell opens its card on the product page; a column head, the product.
    await click(find('免费，三档订阅今天'))
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p1', tab: 'dossier', expand: 'business' })
    await click(all('.op-matrix-product')[1]!)
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p2', tab: 'dossier' })
  })

  it('saves the table as a CSV file a spreadsheet opens', async () => {
    expect(matrixRows(t, overview())).toEqual([
      ['维度', '豆包·小豆', 'Meta Muse', 'Zed'], ['定位', '独立的个人代理', '住在社交 App 里的助手', ''], ['商业化', '免费，三档订阅', '', ''], ['记忆', '', '', ''],
    ])
    expect(toCsv([['维度', 'a,b'], ['说 "好"', '一\n二']])).toBe('\uFEFF维度,"a,b"\r\n"说 ""好""","一\n二"\r\n')
    const made: Blob[] = []
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { made.push(blob as Blob); return 'blob:matrix' })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clicked: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this.download) })
    await show()
    await click('导出表格')
    expect(clicked).toEqual([expect.stringMatching(/^Personal Agent-对比矩阵-\d{4}-\d{2}-\d{2}\.csv$/)])
    const bytes = new Uint8Array(await made[0]!.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]) // the byte-order mark, which reading the text drops
    expect(await made[0]!.text()).toBe(toCsv(matrixRows(t, overview())).slice(1))
  })

  it('saves the table through the desktop app into Downloads, and says where it went or why it did not', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:matrix')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const save = vi.fn(async (_request: { url: string; name?: string; mediaType?: string; mode: string }) =>
      ({ status: 'saved', path: '/Users/me/Downloads/Personal Agent-对比矩阵-2026-11-28 (1).csv' }) as { status: 'saved'; path: string } | { status: 'cancelled' })
    const host = globalThis as { dshDesktop?: unknown }
    host.dshDesktop = { protocolVersion: 1, fileActions: { save } }
    try {
      await show()
      await click('导出表格')
      expect(save).toHaveBeenCalledWith({ url: 'blob:matrix', name: expect.stringMatching(/^Personal Agent-对比矩阵-\d{4}-\d{2}-\d{2}\.csv$/), mediaType: 'text/csv;charset=utf-8', mode: 'download' })
      expect(document.querySelector('[role="status"]')?.textContent).toBe('已存到「下载」文件夹：Personal Agent-对比矩阵-2026-11-28 (1).csv')
      save.mockRejectedValueOnce(new Error('File download unavailable'))
      await click('导出表格')
      expect(document.querySelector('[role="alert"]')?.textContent).toBe('没存成：File download unavailable')
    } finally {
      delete host.dshDesktop
    }
  })

  it('puts each product on the map where the drawing says, leaving out one no longer in the track', async () => {
    const { context } = await show()
    const points = all<HTMLButtonElement>('.op-map-point')
    expect(points.map(point => point.textContent)).toEqual(['豆豆包·小豆', 'MMeta Muse']) // each with its icon
    expect(points[0]!.style.left).toBe(`${11 + 160 / 200 * 78}%`)
    expect(points[0]!.style.top).toBe(`${11 + 30 / 200 * 78}%`)
    // Right of the middle a label grows leftward, so that it stays inside the map.
    expect(points.map(point => point.dataset.side)).toEqual(['left', undefined])
    expect(points[0]!.getAttribute('aria-label')).toBe('豆包·小豆：偏「独立 App」，偏「替你办事」。独立 App，主打代办')
    expect(all('.op-map-axis').map(axis => axis.textContent)).toEqual(['← 寄生在 App 里', '独立 App →', '↑ 替你办事', '↓ 陪聊问答'])
    expect(document.querySelector('.op-tsection-head')?.textContent).toContain('推论')
    expect(all('.op-map-was')).toHaveLength(0) // nothing to compare with yet
    await click(points[1]!)
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p2', tab: 'dossier' })
  })

  it('draws a dashed circle where a product stood at the first drawing on these axes, for one that moved', async () => {
    await show(overview({ since: { date: '2026-11-20', positions: [{ productId: 'p1', x: 0, y: 70, why: '' }, { productId: 'p2', x: -48, y: -20, why: '' }] } }))
    expect(all('.op-map-was')).toHaveLength(1) // Muse moved 2 units: not drawn
    expect(all('.op-map-lines .op-map-trail')).toHaveLength(1)
    expect(text()).toContain(`虚线圈是 ${new Date().getFullYear() === 2026 ? '11-20' : '2026-11-20'} 时的位置`)
  })

  it('offers to draw the map when there is none, and says why it cannot with fewer than two products', async () => {
    let drawn = false
    const { api } = await show(() => overview({ landscape: drawn ? landscape() : null, drawing: false }), {}, { 'POST tracks/:id/map': () => { drawn = true; return { ok: true } } })
    expect(document.querySelector('.op-gist')).toBeNull()
    expect(text()).toContain('还没画过地图')
    expect(text()).toContain('每次几分钱')
    await click('画地图')
    expect(sent(api)).toEqual([['tracks/t1/map', {}]])
    expect(all('.op-map-point')).toHaveLength(2)

    unmount()
    await show(overview({ landscape: null, mappable: 1 }))
    expect(text()).toContain('至少要有两个建好档的产品')
    expect(all('button').map(button => button.textContent)).not.toContain('画地图')
  })

  it('changes the axes: the four ends as they are, sent to draw the map on them', async () => {
    const { api } = await show()
    await click('换轴')
    const ends = all<HTMLInputElement>('.op-axes-form input')
    expect(ends.map(end => end.value)).toEqual(['寄生在 App 里', '独立 App', '陪聊问答', '替你办事'])
    expect(find('按这两条轴重画').hasAttribute('disabled')).toBe(true) // the same axes are 「重画」, not new ones
    await type(ends[0]!, '')
    expect(find('按这两条轴重画').hasAttribute('disabled')).toBe(true)
    await type(ends[0]!, '免费')
    await click('按这两条轴重画')
    expect(sent(api)).toEqual([['tracks/t1/map', { axes: { x: { low: '免费', high: '独立 App' }, y: AXES.y } }]])
    expect(document.querySelector('.op-axes-form')).toBeNull()
  })

  it('shows the drawing under way and the host’s refusal', async () => {
    await show(overview({ drawing: true }), {}, { 'POST tracks/:id/map': () => ({}) })
    expect(text()).toContain('正在画地图')
    expect(find('重画').hasAttribute('disabled')).toBe(true)
    unmount()
    const { fail } = await import('../fixtures/client.tsx')
    await show(overview(), {}, { 'POST tracks/:id/map': fail(409, '地图正在画，等它画完') })
    await click('重画')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('地图正在画，等它画完')
  })

  it('speaks English when DSH does', async () => {
    await show(overview(), { t: tEn })
    expect(document.querySelector('.op-thead-meta')?.textContent).toBe('3 followed · since 11-18 · daily at 08:00 · Looks at: Positioning, Business model, 记忆')
    expect(all('.op-matrix tbody th').map(cell => cell.textContent)).toEqual(['Positioning', 'Business model', '记忆'])
    expect(all('.op-matrix thead th')[2]!.textContent).toBe('MMeta MusePaused')
    expect(find('Export table')).toBeTruthy()
    expect(all('.op-map-point')[0]!.getAttribute('aria-label')).toBe('豆包·小豆: toward “独立 App”; toward “替你办事”. 独立 App，主打代办')
    expect(matrixRows(tEn, overview())[0]![0]).toBe('Dimension')
  })

  it('says why the last drawing made no map, until a drawing works', async () => {
    await show(overview({ unmapped: { status: 'skipped', error: '今日总预算已用完', at: '2026-11-28T01:00:00.000Z' } }))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('这次没画成：今日总预算已用完')
    unmount()
    await show(overview({ unmapped: { status: 'skipped', error: '今日总预算已用完', at: null } }), { t: tEn })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('The last drawing did not work out: Today’s total budget is used up')
    unmount()
    await show(overview({ drawing: true, unmapped: { status: 'failed', error: null, at: null } }))
    expect(document.querySelector('[role="alert"]')).toBeNull() // a new drawing is under way
  })

  it('says the track is gone once it is deleted, instead of showing it as it was', async () => {
    await show(overview(), { state: state({ tracks: [] }) })
    expect(text()).toContain('找不到这个赛道')
    expect(document.querySelector('.op-matrix')).toBeNull()
  })

  it('moves a label that would cover an earlier one down a step, or up at the bottom', () => {
    const [first, near, far] = labelSpots([{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: 80, y: 0 }])
    expect(first!.top).toBe(50)
    expect(near!.top - first!.top).toBeGreaterThanOrEqual(6) // moved down until clear of the first
    expect(far!.top).toBe(50) // far enough across: left where it is
    const low = labelSpots([{ x: 0, y: -100 }, { x: 0, y: -100 }])
    expect(low[1]!.top).toBeLessThan(low[0]!.top)
  })

  it('keeps a spreadsheet from reading a cell as a formula', () => {
    expect(toCsv([['=1+1', '+30%', '-', '@x', '正常']])).toBe("\uFEFF'=1+1,'+30%,'-,'@x,正常\r\n")
  })

  it('says how the weekly suggestions stand, turns them off and on, and leads to the candidates waiting (M2.2)', async () => {
    let on = true
    const weekly = () => ({ on, last: '2026-11-26', next: on ? '2026-12-03' : null, running: false })
    const { api } = await show(() => overview({ weekly: weekly() }), {
      state: state({ runTime: '08:00', tracks: [track('t1', 'Personal Agent', [], {}, 3)] }),
    }, { 'POST tracks/:id/weekly': (req: { body: unknown }) => { on = (req.body as { on: boolean }).on; return weekly() } })
    const line = () => document.querySelector('.op-thead-weekly')?.textContent
    expect(line()).toBe(`每周推荐新产品：开 · 上次 ${new Date().getFullYear() === 2026 ? '11-26' : '2026-11-26'} · 下次 ${new Date().getFullYear() === 2026 ? '12-03' : '2026-12-03'}关掉去看 3 个新候选`)
    await click('关掉')
    expect(sent(api)).toEqual([['tracks/t1/weekly', { on: false }]])
    expect(line()).toBe('每周推荐新产品：关打开去看 3 个新候选')
    await click('打开')
    expect(sent(api).at(-1)).toEqual(['tracks/t1/weekly', { on: true }])
    const { context } = await show(overview(), { state: state({ runTime: '08:00', tracks: [track('t1', 'Personal Agent', [], {}, 3)] }) })
    await click('去看 3 个新候选')
    expect(context.navigate).toHaveBeenCalledWith({ page: 'newTrack', trackId: 't1' })
  })

  it('says a weekly round is under way, and shows no line for a track still being picked', async () => {
    await show(overview({ weekly: { on: true, last: '2026-11-26', next: '2026-12-03', running: true } }))
    expect(document.querySelector('.op-thead-weekly')?.textContent).toBe('每周推荐新产品：开 · 正在找…关掉')
    unmount()
    await show(overview({ track: { ...overview().track, status: 'picking' } }))
    expect(document.querySelector('.op-thead-weekly')).toBeNull()
  })

  it('is a page of its own, remembered with its track', () => {
    expect(parseRoute({ page: 'track', trackId: 't1' })).toEqual({ page: 'track', trackId: 't1' })
    expect(parseRoute({ page: 'track' })).toBeUndefined()
  })
})
