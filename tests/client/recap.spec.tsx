// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecapView } from '../../src/host/jobs/recap.ts'
import { Recap } from '../../src/client/pages/Recap.tsx'
import { parseRoute } from '../../src/client/shell/route.ts'
import { all, briefView, click, find, finding, mount, product, state, stubApi, tEn, text, unmount } from '../fixtures/client.tsx'
import { Today } from '../../src/client/pages/Today.tsx'

afterEach(() => { unmount(); vi.unstubAllGlobals() })

const recap = (over: Partial<RecapView> = {}): RecapView => ({
  track: { id: 't1', name: 'Personal Agent' }, week: '2026-11-23', end: '2026-11-29', complete: true, gist: '小豆开始按额度收费，Muse 扩到英国。',
  findings: [
    { id: 'f1', productId: 'p1', product: '小豆', date: '2026-11-25', importance: 'major', status: 'verified', headline: '小豆开始收费', why: '额度决定花费' },
    { id: 'f2', productId: 'p2', product: 'Muse', date: '2026-11-28', importance: 'notable', status: 'unconfirmed', headline: '据传涨价', why: '只有一个来源' },
  ],
  minor: 3,
  cardChanges: [{ productId: 'p1', product: '小豆', dimension: 'business', label: '商业化', changeNote: '加了定价', date: '2026-11-25' }],
  newProducts: [{ id: 'p3', name: 'Cue' }],
  map: { date: '2026-11-26', gist: '两条路线', moved: ['小豆'] },
  topics: [{ id: 'tp1', question: '谁在收费？', version: 2, changeNote: '加了 Muse', date: '2026-11-27' }],
  quiet: ['Cue'],
  prev: '2026-11-16', next: '2026-11-30', ...over,
})

describe('the weekly recap page', () => {
  it('shows the week with its AI paragraph and what it held, each line opening what it is about', async () => {
    const api = stubApi({ 'GET tracks/:id/recap': recap() })
    const shell = await mount(<Recap />, { route: { page: 'recap', trackId: 't1' } })
    expect(api.requests.map(r => [r.path, r.query])).toEqual([['tracks/t1/recap', {}]])
    expect(document.querySelector('h1')?.textContent).toBe('Personal Agent · 周回顾')
    expect(document.querySelector('.op-recap-range')?.textContent).toBe('11-23 – 11-29')
    expect(document.querySelector('.op-gist')?.textContent).toContain('小豆开始按额度收费')
    expect(all('.op-search-group-title').map(h => h.textContent)).toEqual(['值得看的发现2', '档案的变化1', '新建档', '定位地图', '专题的新版本1'])
    expect(text()).toContain('另有 3 条小更新')
    expect(text()).toContain('挪了位置：小豆')
    expect(text()).toContain('整周没动静：Cue')
    const lines = all('.op-search-hit')
    await click(lines[0]!)
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p1', tab: 'feed', finding: 'f1' })
    await click(lines[2]!)
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p1', tab: 'dossier', expand: 'business' })
    await click(lines.at(-1)!)
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'topic', topicId: 'tp1' })
    await click(find('‹ 上一周'))
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'recap', trackId: 't1', week: '2026-11-16' })
  })

  it('says a week still open has no paragraph yet, and an empty week has nothing; in English too', async () => {
    stubApi({ 'GET tracks/:id/recap': recap({ week: '2026-11-30', end: '2026-12-06', complete: false, gist: null, findings: [], minor: 0, cardChanges: [], newProducts: [], map: null, topics: [], quiet: ['小豆', 'Muse', 'Cue'], next: null }) })
    await mount(<Recap />, { route: { page: 'recap', trackId: 't1', week: '2026-11-30' }, t: tEn })
    expect(document.querySelector('.op-recap-open')?.textContent).toBe('This week so far')
    expect(text()).toContain('Once the week is over, an AI summary is written')
    expect(text()).toContain('Nothing new in this track this week.')
    expect(text()).not.toContain('Quiet all week')
    expect(find('Next week ›').hasAttribute('disabled')).toBe(true)
  })
})

describe('the brief', () => {
  it('says which recaps came out that day, and opens them', async () => {
    const p = product('p1', '小豆')
    stubApi({ 'GET brief': briefView({ findings: [finding('f1', 'p1')], products: [p], recaps: [{ trackId: 't1', track: 'Personal Agent', week: '2026-11-23' }] }), 'POST findings/:id/read': { ok: true } })
    const shell = await mount(<Today />, { state: state() })
    expect(document.querySelector('.op-recaps-out')?.textContent).toBe('上周回顾已出：Personal Agent')
    await click(find('Personal Agent', '.op-recaps-out button'))
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'recap', trackId: 't1', week: '2026-11-23' })
  })
})

describe('the route', () => {
  it('reads a recap, with or without its week', () => {
    expect(parseRoute({ page: 'recap', trackId: 't1', week: '2026-11-23' })).toEqual({ page: 'recap', trackId: 't1', week: '2026-11-23' })
    expect(parseRoute({ page: 'recap', trackId: 't1', week: 'monday' })).toEqual({ page: 'recap', trackId: 't1' })
    expect(parseRoute({ page: 'recap' })).toBeUndefined()
  })
})
