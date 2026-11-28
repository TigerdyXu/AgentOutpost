import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { Axes, Id, ProductStatus, Track } from '../../src/core/types.ts'
import { describeTrack, drawLandscape, mappable, needsDrawing, parseLandscape, type LandscapeDeps } from '../../src/host/jobs/landscape.ts'
import type { ModelClient } from '../../src/host/ports.ts'
import { renderPrompt } from '../../src/host/prompts.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { usage } from '../fixtures/fake-driver.ts'

const TODAY = '2026-11-28'
const AXES: Axes = { x: { low: '寄生在 App 里', high: '独立 App' }, y: { low: '陪聊问答', high: '替你办事' } }
const answer = (over: Record<string, unknown> = {}) => JSON.stringify({
  gist: '两条路线：小豆独立办事，Muse 寄生社交', axes: AXES,
  positions: [{ id: 'P1', x: 60, y: 70, why: '独立 App，主打代办' }, { id: 'P2', x: -50, y: -20, why: '住在 WhatsApp 里' }], ...over,
})

let dir: string
let db: Db
let repo: Repo
let now: Date
let complete: ReturnType<typeof vi.fn<ModelClient['complete']>>
let budget: number
let deps: LandscapeDeps
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-landscape-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  now = new Date('2026-11-28T09:00:00.000Z')
  repo = new Repo(db, () => now)
  complete = vi.fn<ModelClient['complete']>(async () => ({ text: answer(), usage: usage({ inputTokens: 4000, outputTokens: 300 }) }))
  budget = 10
  deps = {
    repo, model: { complete }, clock: { now: () => now, at: () => () => {}, tick: () => () => {} } as never,
    settings: () => ({ dailyBudgetYuan: budget, billingFor: () => 'metered', pricesOf: () => ({ inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.2 }), model: null, verifyModel: null, briefModel: null, followupModel: null }),
  }
  track = repo.createTrack({ name: 'Personal Agent', brief: '能替人办事的 Agent', dimensions: DEFAULT_DIMENSIONS.slice(0, 2), status: 'active' })
  addProduct('p1', '小豆')
  addProduct('p2', 'Muse')
  card('p1', 'positioning', '独立的个人代理', '2026-11-26T00:00:00.000Z')
  card('p2', 'positioning', '住在社交 App 里的助手', '2026-11-26T00:00:00.000Z')
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function addProduct(id: Id, name: string, status: ProductStatus = 'tracking') {
  repo.upsertProduct({ id, name, company: `${name}公司`, region: 'domestic', form: 'App', iconPath: null, officialDomains: [], status, dailyBudgetYuan: null })
  repo.linkProduct(track.id, id)
}
function card(productId: Id, dimension: string, summary: string, createdAt: string, version = 1) {
  repo.addCardVersion({ productId, dimension, version, summary, bullets: ['要点一', '要点二'], body: '正文', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt })
}
const runs = () => repo.runsOfDate(TODAY, 'landscape')

describe('parseLandscape', () => {
  it('reads the drawing, P1 being the first product, whatever is written around the JSON', () => {
    expect(parseLandscape(`好的，下面是地图：\n\`\`\`json\n${answer()}\n\`\`\``, ['p1', 'p2'], null)).toEqual({
      gist: '两条路线：小豆独立办事，Muse 寄生社交', axes: AXES,
      positions: [{ productId: 'p1', x: 60, y: 70, why: '独立 App，主打代办' }, { productId: 'p2', x: -50, y: -20, why: '住在 WhatsApp 里' }],
    })
  })

  it('keeps fixed axes whatever the answer says, rounds coordinates into -100…100 and cuts a long why', () => {
    const fixed: Axes = { x: { low: '左', high: '右' }, y: { low: '下', high: '上' } }
    const drawn = parseLandscape(answer({ positions: [{ id: 'p2', x: 140.4, y: -0.6, why: '很长'.repeat(30) }, { id: 'P1', x: -101, y: 3 }] }), ['p1', 'p2'], fixed)!
    expect(drawn.axes).toEqual(fixed)
    expect(drawn.positions).toEqual([{ productId: 'p1', x: -100, y: 3, why: '' }, { productId: 'p2', x: 100, y: -1, why: '很长'.repeat(20) }])
  })

  it('refuses an answer that is not a whole drawing', () => {
    const ids = ['p1', 'p2']
    const one = { id: 'P1', x: 1, y: 1, why: '' }
    for (const [why, text] of [
      ['no JSON', '画不出来'],
      ['broken JSON', '{"gist": '],
      ['no gist', answer({ gist: '' })],
      ['gist over 60', answer({ gist: '格'.repeat(61) })],
      ['an axis end over 12', answer({ axes: { ...AXES, x: { low: '很'.repeat(13), high: '右' } } })],
      ['an axis missing', answer({ axes: { x: AXES.x } })],
      ['a product missing', answer({ positions: [one] })],
      ['a product twice', answer({ positions: [one, one] })],
      ['a product not asked for', answer({ positions: [one, { id: 'P3', x: 1, y: 1 }] })],
      ['a coordinate not a number', answer({ positions: [one, { id: 'P2', x: '10', y: 1 }] })],
    ] as const) expect(parseLandscape(text, ids, null), why).toBeNull()
  })
})

describe('describeTrack', () => {
  it('numbers the products, lists their cards by the track’s dimensions, and gives fixed axes and last positions', () => {
    card('p1', 'audience', '想把事交出去的人', '2026-11-27T00:00:00.000Z')
    const previous = repo.addLandscape({ trackId: track.id, date: '2026-11-27', gist: 'g', axes: AXES, positions: [{ productId: 'p1', x: 10, y: 20, why: '' }], runId: null })
    card('p1', 'positioning', '独立的个人代理，开始收费', '2026-11-28T09:30:00.000Z', 2) // after the last drawing (09:00)
    const text = describeTrack(track, mappable(repo, track), TODAY, AXES, previous)
    expect(text).toContain('赛道：Personal Agent')
    expect(text).toContain('固定的两条轴（原样照用，不要换）：\n- 横轴：寄生在 App 里 ↔ 独立 App\n- 纵轴：陪聊问答 ↔ 替你办事')
    expect(text).toContain('P1 小豆（小豆公司）\n  上次的位置：x=10, y=20\n  最近改过：定位\n  - 定位：独立的个人代理，开始收费（要点一；要点二）\n  - 目标人群：想把事交出去的人（要点一；要点二）')
    expect(text).toContain('P2 Muse（Muse公司）\n  上次没有它（新加进来的）')
  })

  it('has a prompt that asks for JSON with the fixed axes kept and quiet products left where they were', () => {
    const prompt = renderPrompt('landscape', {})
    for (const rule of ['固定的轴', '原样照抄', '-100 到 100', '上次的位置', '照旧', '不超过 60 字', '只输出一个 JSON', '"positions"', '不加新事实']) expect(prompt, rule).toContain(rule)
  })
})

describe('mappable and needsDrawing', () => {
  it('places followed products with a card of the track’s dimensions, and needs two of them', () => {
    addProduct('p3', '还在建档', 'baselining')
    card('p3', 'positioning', 'x', '2026-11-26T00:00:00.000Z')
    addProduct('p4', '只有别的维度')
    card('p4', 'business', '收费', '2026-11-26T00:00:00.000Z')
    addProduct('p5', '暂停了', 'paused')
    card('p5', 'audience', '人群', '2026-11-26T00:00:00.000Z')
    expect(mappable(repo, track).map(item => item.product.id)).toEqual(['p1', 'p2', 'p5'])

    const lone = repo.createTrack({ name: '一个', brief: '', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
    repo.linkProduct(lone.id, 'p1')
    expect(needsDrawing(repo, lone)).toBe(false)
  })

  it('draws again only when the products or their cards changed since the last drawing', () => {
    expect(needsDrawing(repo, track)).toBe(true) // none yet
    repo.addLandscape({ trackId: track.id, date: '2026-11-27', gist: 'g', axes: AXES, positions: [{ productId: 'p1', x: 0, y: 0, why: '' }, { productId: 'p2', x: 0, y: 0, why: '' }], runId: null })
    expect(needsDrawing(repo, track)).toBe(false)
    now = new Date('2026-11-28T10:00:00.000Z')
    card('p2', 'positioning', '开始做平台', '2026-11-28T09:30:00.000Z', 2)
    expect(needsDrawing(repo, track)).toBe(true)
    repo.addLandscape({ trackId: track.id, date: TODAY, gist: 'g', axes: AXES, positions: [{ productId: 'p1', x: 0, y: 0, why: '' }, { productId: 'p2', x: 0, y: 0, why: '' }], runId: null })
    expect(needsDrawing(repo, track)).toBe(false)
    addProduct('p3', 'Cue')
    card('p3', 'positioning', '记忆型助理', '2026-11-26T00:00:00.000Z')
    expect(needsDrawing(repo, track)).toBe(true) // a product joined
  })
})

describe('drawLandscape', () => {
  it('asks the brief’s model, keeps the drawing and counts its cost in a landscape run', async () => {
    const drawn = await drawLandscape(deps, track.id, TODAY)
    expect(drawn).toMatchObject({ trackId: track.id, date: TODAY, gist: '两条路线：小豆独立办事，Muse 寄生社交', axes: AXES })
    expect(repo.latestLandscape(track.id)).toEqual(drawn)
    expect(runs()).toEqual([expect.objectContaining({ kind: 'landscape', trackId: track.id, productId: null, status: 'done', error: null, costYuan: expect.any(Number) })])
    expect(runs()[0]!.costYuan).toBeGreaterThan(0)
    expect(drawn!.runId).toBe(runs()[0]!.id)
    const [request] = complete.mock.calls[0]!
    expect(request.system).toContain('定位地图')
    expect(request.user).not.toContain('固定的两条轴') // the first drawing proposes them
  })

  it('keeps the last drawing’s axes, or the user’s, and with the user’s does not tell the old positions', async () => {
    await drawLandscape(deps, track.id, TODAY)
    complete.mockResolvedValueOnce({ text: answer({ axes: { x: { low: 'a', high: 'b' }, y: { low: 'c', high: 'd' } } }), usage: usage({}) })
    expect((await drawLandscape(deps, track.id, TODAY))!.axes).toEqual(AXES)
    expect(complete.mock.calls[1]![0].user).toContain('上次的位置')

    const mine: Axes = { x: { low: '免费', high: '收费' }, y: { low: '国内', high: '海外' } }
    expect((await drawLandscape(deps, track.id, TODAY, mine))!.axes).toEqual(mine)
    const asked = complete.mock.calls[2]![0].user
    expect(asked).toContain('- 横轴：免费 ↔ 收费')
    expect(asked).not.toContain('上次的位置')
  })

  it('dates the drawing by when it read the dossiers, so a card written while the model was asked is news next time', async () => {
    complete.mockImplementationOnce(async () => {
      now = new Date('2026-11-28T09:01:00.000Z') // a check finishing while the map is drawn
      card('p2', 'positioning', '开始做平台', now.toISOString(), 2)
      now = new Date('2026-11-28T09:02:00.000Z')
      return { text: answer(), usage: usage({}) }
    })
    const drawn = await drawLandscape(deps, track.id, TODAY)
    expect(drawn!.createdAt).toBe('2026-11-28T09:00:00.000Z')
    expect(needsDrawing(repo, track)).toBe(true)
  })

  it('takes the map’s own axes sent again for a plain redraw, telling the last positions', async () => {
    await drawLandscape(deps, track.id, TODAY)
    await drawLandscape(deps, track.id, TODAY, { x: { ...AXES.x }, y: { ...AXES.y } })
    expect(complete.mock.calls[1]![0].user).toContain('上次的位置')
  })

  it('draws nothing, and starts no run, with fewer than two products to place', async () => {
    const lone = repo.createTrack({ name: '一个', brief: '', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
    repo.linkProduct(lone.id, 'p1')
    expect(await drawLandscape(deps, lone.id, TODAY)).toBeNull()
    expect(runs()).toEqual([])
    expect(complete).not.toHaveBeenCalled()
  })

  it('is held to the day’s budget', async () => {
    budget = 0
    expect(await drawLandscape(deps, track.id, TODAY)).toBeNull()
    expect(runs()[0]).toMatchObject({ status: 'skipped', error: '今日总预算已用完' })
    expect(complete).not.toHaveBeenCalled()
  })

  it('keeps the old drawing when the answer cannot be used, saying so on a run that still counts its cost', async () => {
    complete.mockResolvedValueOnce({ text: '{"gist": "没有位置"}', usage: usage({ inputTokens: 4000 }) })
    expect(await drawLandscape(deps, track.id, TODAY)).toBeNull()
    expect(repo.latestLandscape(track.id)).toBeNull()
    expect(runs()[0]).toMatchObject({ status: 'done', error: expect.stringContaining('地图用不了') })
    expect(runs()[0]!.costYuan).toBeGreaterThan(0)
  })

  it('records a failed call as a failed run', async () => {
    complete.mockRejectedValueOnce(new Error('429 Too Many Requests'))
    expect(await drawLandscape(deps, track.id, TODAY)).toBeNull()
    expect(runs()[0]).toMatchObject({ status: 'failed', error: '429 Too Many Requests' })
  })
})
