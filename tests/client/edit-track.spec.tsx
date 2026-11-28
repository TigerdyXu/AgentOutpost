// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { Dimension } from '../../src/core/types.ts'
import { EditTrack } from '../../src/client/pages/EditTrack.tsx'
import { MiddleColumn } from '../../src/client/shell/MiddleColumn.tsx'
import { parseRoute } from '../../src/client/shell/route.ts'
import type { Shell } from '../../src/client/shell/context.ts'
import { all, click, fail, find, mount, product, state, stubApi, t, tEn, text, track, tracked, type, unmount } from '../fixtures/client.tsx'

const DIMENSIONS: Dimension[] = [{ key: 'positioning', label: '定位' }, { key: 'business', label: '商业化' }, { key: 'pricing', label: '定价' }]
const doubao = product('p1', '豆包·小豆'), muse = product('p2', 'Meta Muse'), cue = product('p3', 'Cue')
const shellState = state({ tracks: [
  track('t1', 'Personal Agent', [tracked(doubao), tracked(muse)], { dimensions: DIMENSIONS, brief: '能替人跨 App 办事的个人代理' }),
  track('t2', '手机 AI 助理', [tracked(muse), tracked(cue)]),
] })
const SAVED = { ...shellState.tracks[0]!.track, toppedUp: 0 }

async function show(shell: Partial<Shell> = {}, extra: Record<string, unknown> = {}) {
  const api = stubApi({ 'PATCH tracks/:id': SAVED, 'POST tracks/:id/delete': { ok: true, deletedProducts: 1 }, ...extra })
  const context = await mount(<EditTrack />, { state: shellState, route: { page: 'editTrack', trackId: 't1' }, ...shell })
  return { api, context }
}
const fields = () => all<HTMLInputElement>('.op-dim-row input')
const sent = (api: ReturnType<typeof stubApi>, method: string) => api.requests.filter(request => request.method === method).map(request => [request.path, request.body])

afterEach(() => { unmount() })

describe('编辑赛道 (M1.5)', () => {
  it('shows the track’s name, what it follows and its dimensions, and saves them together', async () => {
    const { api, context } = await show()
    expect(find('赛道名', 'input, label') ).toBeTruthy()
    expect(document.querySelector<HTMLInputElement>('.op-track-form input')!.value).toBe('Personal Agent')
    expect(document.querySelector('textarea')!.value).toBe('能替人跨 App 办事的个人代理')
    expect(fields().map(field => field.value)).toEqual(['定位', '商业化', '定价'])
    await type(fields()[0]!, '产品定位')
    await click(find('删掉维度「商业化」'))
    await click('＋ 加一个维度')
    await type(fields().at(-1)!, '隐私')
    await click('保存')
    expect(sent(api, 'PATCH')).toEqual([['tracks/t1', { name: 'Personal Agent', brief: '能替人跨 App 办事的个人代理', dimensions: [
      { key: 'positioning', label: '产品定位' }, { key: 'pricing', label: '定价' }, { label: '隐私' },
    ] }]])
    expect(context.refresh).toHaveBeenCalled()
    expect(text()).toContain('已保存')
  })

  it('says how many products get the new dimensions’ cards at once', async () => {
    await show({}, { 'PATCH tracks/:id': { ...SAVED, toppedUp: 2 } })
    await click('＋ 加一个维度')
    await type(fields().at(-1)!, '隐私')
    await click('保存')
    expect(text()).toContain('已保存 · 2 个产品马上补新维度的卡片')
  })

  it('in English, shows the default dimensions in English and sends them back under their stored names', async () => {
    const { api } = await show({ t: tEn })
    expect(fields().map(field => field.value)).toEqual(['Positioning', 'Business model', '定价'])
    await type(fields()[1]!, 'Revenue')
    await click('Save')
    expect(sent(api, 'PATCH')[0]![1]).toMatchObject({ dimensions: [
      { key: 'positioning', label: '定位' }, { key: 'business', label: 'Revenue' }, { key: 'pricing', label: '定价' },
    ] })
  })

  it('does not send a page with an empty dimension, one named twice, or none at all', async () => {
    const { api } = await show()
    await type(fields()[2]!, ' ')
    await click('保存')
    expect(find('维度名不能为空', '[role="alert"]')).toBeTruthy()
    await type(fields()[2]!, '定位')
    await click('保存')
    expect(find('维度「定位」重复了', '[role="alert"]')).toBeTruthy()
    for (const label of ['定位', '商业化', '定位']) await click(find(`删掉维度「${label}」`))
    await click('保存')
    expect(find('至少留一个维度', '[role="alert"]')).toBeTruthy()
    expect(sent(api, 'PATCH')).toEqual([])
  })

  it('names the products that go with the track, asks once more, deletes it and goes to the brief', async () => {
    const { api, context } = await show()
    expect(text()).toContain('只在这个赛道里的 1 个产品会一起删掉：豆包·小豆。')
    expect(text()).toContain('同时在别的赛道里的 Meta Muse 会留下。')
    await click('删除这个赛道…')
    expect(sent(api, 'POST')).toEqual([])
    await click('确认删除')
    expect(sent(api, 'POST')).toEqual([['tracks/t1/delete', undefined]])
    expect(context.refresh).toHaveBeenCalled()
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'today' })
  })

  it('says why a track cannot be deleted yet, and stays', async () => {
    const { context } = await show({}, { 'POST tracks/:id/delete': fail(409, '这个赛道的推荐或产品确认还在进行，等它跑完再删') })
    await click('删除这个赛道…')
    await click('确认删除')
    expect(find('这个赛道的推荐或产品确认还在进行，等它跑完再删', '[role="alert"]')).toBeTruthy()
    expect(context.navigate).not.toHaveBeenCalled()
  })

  it('says so when the track is gone', async () => {
    await show({ route: { page: 'editTrack', trackId: 'nope' } })
    expect(text()).toContain('找不到这个赛道')
  })

  it('is opened from the ⋯ beside the track’s name, which shows while its page is open', async () => {
    const context = await mount(<MiddleColumn />, { state: shellState })
    await click(find('「Personal Agent」的设置'))
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'editTrack', trackId: 't1' })
    unmount()
    await mount(<MiddleColumn />, { state: shellState, route: { page: 'editTrack', trackId: 't1' } })
    expect(find('「Personal Agent」的设置').getAttribute('aria-current')).toBe('page')
    expect(find('「手机 AI 助理」的设置').getAttribute('aria-current')).toBeNull()
    expect(t('nav.trackSettings', { track: 'x' })).toBe('「x」的设置')
  })

  it('is a page the panel remembers', () => {
    expect(parseRoute({ page: 'editTrack', trackId: 't1' })).toEqual({ page: 'editTrack', trackId: 't1' })
    expect(parseRoute({ page: 'editTrack' })).toBeUndefined()
  })
})
