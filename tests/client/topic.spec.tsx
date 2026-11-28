// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { Topic as TopicRecord, TopicVersion } from '../../src/core/types.ts'
import type { TopicRow, TopicView, TrackOverview } from '../../src/host/api.ts'
import { Topic } from '../../src/client/pages/Topic.tsx'
import { TopicsTab } from '../../src/client/pages/product/TopicsTab.tsx'
import { Track } from '../../src/client/pages/Track.tsx'
import { parseRoute } from '../../src/client/shell/route.ts'
import { all, click, fail, find, mount, product, source, state, stubApi, tEn, text, track, type, unmount } from '../fixtures/client.tsx'

const doubao = product('p1', '豆包·小豆'), muse = product('p2', 'Meta Muse'), cue = product('p3', 'Cue', { status: 'paused' })
const topicRecord = (over: Partial<TopicRecord> = {}): TopicRecord => ({ id: 'tp1', trackId: 't1', question: '谁能记住用户的偏好', productIds: ['p1', 'p2'], cadence: 'weekly', createdAt: '2026-11-28T01:00:00.000Z', ...over })
const row = (over: Partial<TopicRow> = {}): TopicRow => ({
  topic: topicRecord(), productNames: ['豆包·小豆', 'Meta Muse'], versions: 2, first: '2026-11-21T01:00:00.000Z', last: '2026-11-28T01:00:00.000Z', lastNote: '补上跨设备',
  researching: false, problem: null, next: '2026-12-05', ...over,
})
const version = (over: Partial<TopicVersion> = {}): TopicVersion => ({
  id: 'v2', topicId: 'tp1', version: 2, status: 'final', changeNote: '补上跨设备', runId: 'r2', createdAt: '2026-11-28T01:00:00.000Z',
  cards: [{ title: '记什么', summary: '两家都记偏好', bullets: ['偏好卡片[1]'], body: '小豆记偏好。[1]Muse 也记。[2]', sourceIds: ['s1', 's2'], inferenceSpans: [], productIds: ['p1', 'p2'] }],
  ...over,
})
const view = (over: Partial<TopicView> = {}): TopicView => ({
  row: row(), track: { id: 't1', name: 'Personal Agent' }, products: [doubao, muse], version: version(),
  history: [{ version: 2, changeNote: '补上跨设备', createdAt: '2026-11-28T01:00:00.000Z' }, { version: 1, changeNote: '首版', createdAt: '2026-11-21T01:00:00.000Z' }],
  sources: [source('s1', { publisher: '豆包官网' }), source('s2', { publisher: 'Meta' })], ...over,
})

afterEach(() => { unmount() })

describe('专题页 (M2.3)', () => {
  async function show(answer: TopicView | (() => TopicView) = view(), extra: Record<string, unknown> = {}, shell = {}) {
    const api = stubApi({ 'GET topics/:id': typeof answer === 'function' ? answer : () => answer, 'POST topics/:id/update': { ok: true }, 'PATCH topics/:id': topicRecord({ cadence: 'once' }), 'POST topics/:id/delete': { ok: true }, ...extra })
    const context = await mount(<Topic />, { route: { page: 'topic', topicId: 'tp1' }, ...shell })
    return { api, context }
  }
  const posts = (api: ReturnType<typeof stubApi>) => api.requests.filter(r => r.method !== 'GET').map(r => [r.method, r.path, r.body])

  it('shows the question, its track, products and version, and the cards as a dossier shows them', async () => {
    const { context } = await show()
    expect(document.querySelector('h1')?.textContent).toBe('谁能记住用户的偏好')
    expect(document.querySelector('.op-thead-meta')?.textContent).toBe(`「Personal Agent」的专题 · 每周更新 · 第 2 版 · ${new Date().getFullYear() === 2026 ? '11-28' : '2026-11-28'} · 下次 ${new Date().getFullYear() === 2026 ? '12-05' : '2026-12-05'}`)
    expect(text()).toContain('这一版：补上跨设备')
    const card = document.querySelector('.op-topic-card')!
    expect(card.querySelector('h3')?.textContent).toBe('记什么')
    expect(card.querySelector('.op-topic-summary')?.textContent).toBe('两家都记偏好')
    expect(card.querySelector('.op-topic-about')?.textContent).toBe('豆包·小豆、Meta Muse')
    await click(find('展开'))
    expect(card.querySelectorAll('.op-source')).toHaveLength(2)
    expect(all('.op-topic-history li').map(li => li.textContent)).toHaveLength(2)
    await click(find('Meta Muse'))
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p2', tab: 'topics' })
  })

  it('updates now, changes how often, and deletes after asking once more', async () => {
    const { api, context } = await show()
    await click('立即更新')
    await click('改成一次性')
    await click('删除专题')
    await click('确认删除')
    expect(posts(api)).toEqual([['POST', 'topics/tp1/update', undefined], ['PATCH', 'topics/tp1', { cadence: 'once' }], ['POST', 'topics/tp1/delete', undefined]])
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'track', trackId: 't1' })
  })

  it('says a round is under way, or why the last one made no version', async () => {
    await show(view({ row: row({ researching: true }), version: null, history: [] }))
    expect(text()).toContain('正在深挖：一次调研加一次核查')
    expect(find('正在深挖…').hasAttribute('disabled')).toBe(true)
    unmount()
    await show(view({ row: row({ problem: '核查后没有一张卡片站得住' }) }))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('这次没出新版：核查后没有一张卡片站得住')
    unmount()
    await show(view({ row: row({ problem: '核查后没有一张卡片站得住' }) }), {}, { t: tEn })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('No new version this time: No card held up under the check')
    unmount()
    await show(view(), { 'POST topics/:id/update': fail(409, '这个专题正在深挖，等它跑完') })
    await click('立即更新')
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('这个专题正在深挖，等它跑完')
  })

  it('is a page of its own', () => {
    expect(parseRoute({ page: 'topic', topicId: 'tp1' })).toEqual({ page: 'topic', topicId: 'tp1' })
    expect(parseRoute({ page: 'topic' })).toBeUndefined()
    expect(parseRoute({ page: 'product', productId: 'p1', tab: 'topics' })).toEqual({ page: 'product', productId: 'p1', tab: 'topics' })
  })
})

describe('专题 on the track page and the product page (M2.3)', () => {
  const overview = (over: Partial<TrackOverview> = {}): TrackOverview => ({
    track: track('t1', 'Personal Agent', [], { status: 'active' }).track,
    products: [{ product: doubao, cards: [] }, { product: muse, cards: [] }, { product: cue, cards: [] }],
    landscape: null, since: null, drawing: false, mappable: 0, unmapped: null, weekly: { on: true, last: null, next: null, running: false, problem: null },
    topics: [row(), row({ topic: topicRecord({ id: 'tp2', question: '谁收费', cadence: 'once' }), versions: 0, first: null, last: null, lastNote: null, researching: true })], ...over,
  })
  async function show(extra: Record<string, unknown> = {}) {
    const api = stubApi({ 'GET tracks/:id/overview': () => overview(), 'POST tracks/:id/topics': { topicId: 'tp9' }, ...extra })
    const context = await mount(<Track />, { state: state({ tracks: [track('t1', 'Personal Agent', [])] }), route: { page: 'track', trackId: 't1' } })
    return { api, context }
  }

  it('lists the track’s topics with how each stands, each opening its page', async () => {
    const { context } = await show()
    expect(all('.op-topic-row').map(button => [button.querySelector('.op-topic-q')?.textContent, button.querySelector('.op-topic-meta')?.textContent])).toEqual([
      ['谁能记住用户的偏好', `2 个产品 · ${new Date().getFullYear() === 2026 ? '11-21' : '2026-11-21'} 首版 · 每周更新 · 上一版：补上跨设备`],
      ['谁收费', '2 个产品 · 正在深挖… · 一次性'],
    ])
    await click(all('.op-topic-row')[0]!)
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'topic', topicId: 'tp1' })
  })

  it('starts one: the question, the products followed (tracked ones ticked), once or weekly, then its page', async () => {
    const { api, context } = await show()
    await click('＋ 写一个问题，AI 去深挖')
    const boxes = all<HTMLInputElement>('.op-topic-product input')
    expect(all('.op-topic-product').map(label => label.textContent)).toEqual(['豆豆包·小豆', 'MMeta Muse', 'CCue'])
    expect(boxes.map(box => box.checked)).toEqual([true, true, false]) // a paused one is offered, not ticked
    expect(text()).toContain('每次约 ¥1–2')
    expect(find('开始深挖').hasAttribute('disabled')).toBe(true) // no question yet
    await type('.op-topic-form textarea', '谁在做主动提醒')
    await click(boxes[1]!)
    await click(all<HTMLInputElement>('.op-topic-cadence input')[1]!)
    await click('开始深挖')
    expect(api.requests.filter(r => r.method === 'POST').map(r => [r.path, r.body])).toEqual([['tracks/t1/topics', { question: '谁在做主动提醒', productIds: ['p1'], cadence: 'weekly' }]])
    expect(context.navigate).toHaveBeenLastCalledWith({ page: 'topic', topicId: 'tp9' })
  })

  it('lists on a product’s 专题 tab the topics about it, or says there are none', async () => {
    stubApi({ 'GET products/:id/topics': { topics: [row()] } })
    await mount(<TopicsTab productId="p1" />)
    expect(all('.op-topic-q').map(q => q.textContent)).toEqual(['谁能记住用户的偏好'])
    unmount()
    stubApi({ 'GET products/:id/topics': { topics: [] } })
    await mount(<TopicsTab productId="p1" />)
    expect(text()).toContain('还没有涉及它的专题')
  })
})
