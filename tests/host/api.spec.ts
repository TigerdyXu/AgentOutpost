import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unreadCount } from '../../src/core/brief.ts'
import { DEFAULT_DIMENSIONS, slugDimension } from '../../src/core/dimensions.ts'
import type { Brief, Dimension, Finding, Id, ProductStatus, Run, Source, Track } from '../../src/core/types.ts'
import type { ApiResponse } from '../../src/host/api.ts'
import type { Runtime } from '../../src/host/runtime.ts'
import type { Repo } from '../../src/store/repo.ts'
import { apiHost, type ApiHost, type Reply } from '../fixtures/api-host.ts'
import { completed, flush, gate, type Play } from '../fixtures/fake-driver.ts'

const TODAY = '2026-11-25'
const RECOMMEND = 'outpost-recommend-'
const DAILY = 'outpost-daily-'
const BASELINE = 'outpost-baseline-'

let host: ApiHost
let rt: Runtime
let repo: Repo
beforeEach(() => {
  host = apiHost()
  rt = host.create()
  rt.start()
  repo = rt.repo
})
afterEach(async () => {
  await rt.stop()
  host.cleanup()
})

// ---- seeding ----

const addTrack = (over: Partial<Omit<Track, 'id' | 'createdAt'>> = {}) =>
  repo.createTrack({ name: 'AI 编程助手', brief: '盯住编程类 Agent', dimensions: DEFAULT_DIMENSIONS, status: 'active', ...over })
const addProduct = (id: Id, name: string, status: ProductStatus = 'tracking', trackId?: Id) => {
  const product = repo.upsertProduct({ id, name, company: `${name} Inc`, region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status, dailyBudgetYuan: null })
  if (trackId) repo.linkProduct(trackId, id)
  return product
}
const addSource = (title: string) => repo.addSource({
  url: `https://example.com/${encodeURIComponent(title)}`, title, publisher: '36氪', publishedAt: '2026-11-24', kind: 'media', isOfficial: false,
  quote: `${title}的原话`, syndicationGroup: null, openedVia: 'http', quoteFound: true, supportsClaim: true,
})
/** A finding handed in by a finished daily run dated `date`. */
const addFinding = (productId: Id, over: Partial<Finding> = {}, date = TODAY) => {
  const run = repo.createRun({ kind: 'daily', date, trackId: null, productId })
  repo.updateRun(run.id, { status: 'done', startedAt: `${date}T00:00:00.000Z`, endedAt: `${date}T00:10:00.000Z` })
  return repo.addFinding({
    productId, runId: run.id, headline: '后台 Agent 正式上线', why: '值得看', importance: 'major', claimKind: 'self', sourceIds: [], status: 'verified',
    statusNote: null, unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: randomUUID(), verifiedOn: date, ...over,
  })
}
const putBrief = (date: string, findingIds: Id[], over: Partial<Brief> = {}) => repo.putBrief({
  date, gist: '今天一条重要更新。', findingIds, minorIds: [], quietProductIds: [], skipped: [], costYuan: 0.5,
  createdAt: `${date}T01:00:00.000Z`, updatedAt: `${date}T01:00:00.000Z`, ...over,
})
const addRun = (kind: Run['kind'], patch: Partial<Run> = {}, date = TODAY, about: { trackId?: Id; productId?: Id } = {}) => {
  const run = repo.createRun({ kind, date, trackId: about.trackId ?? null, productId: about.productId ?? null })
  repo.updateRun(run.id, patch)
  return repo.getRun(run.id)!
}
const card = (productId: Id, dimension: string, version: number, sourceIds: Id[], changeNote = '建档') => repo.addCardVersion({
  productId, dimension, version, summary: `${dimension} v${version}`, bullets: ['一条结论'], body: '正文[1]', sourceIds, inferenceSpans: [], addedSpans: [],
  changeNote, findingIds: [], createdAt: `2026-11-2${version}T00:00:00.000Z`,
})

/** A recommendation agent that hands in these candidates (name, tier), then finishes once `until` opens. */
const recommends = (candidates: [string, 'strong' | 'consider' | 'excluded'][], until?: Promise<void>, company = (name: string) => `${name} Inc`): Play => async round => {
  for (const [name, tier] of candidates) {
    await round.call('outpost_submit_candidate', {
      name, company: company(name), region: 'overseas', form: 'IDE', oneLiner: `${name} 是 AI 编辑器`, tier, reason: '热度高',
      articles: [{ url: `https://example.com/${name}`, title: `${name} 发布`, publishedAt: '2026-11-20' }],
    })
  }
  await until
  await round.done('推荐完了')
  return completed()
}
/** A session that holds its round until `held` opens (or Outpost stops), then finishes. */
const holds = (held: Promise<void>): Play => async round => {
  await Promise.race([held, new Promise(resolve => round.signal.addEventListener('abort', resolve))])
  if (!round.signal.aborted) await round.done('完成')
  return completed()
}
const ok = (reply: Reply) => { expect(reply.status, reply.body.toString()).toBe(200); return reply }

// ---- the routes ----

describe('routing', () => {
  it('answers the health check and 404 for an unknown operation', async () => {
    expect(ok(await host.call('GET', 'health')).json()).toEqual({ ok: true })
    for (const [method, path] of [['GET', 'nope'], ['DELETE', 'tracks/t1'], ['GET', 'state/extra'], ['POST', 'state']]) {
      const reply = await host.call(method!, path!)
      expect(reply.status, `${method} ${path}`).toBe(404)
      expect(reply.json()).toEqual({ error: 'Unknown operation' })
    }
  })

  it('hands a param with an escaped slash to the route whole', async () => {
    const reply = await host.call('GET', 'products/a%2Fb')
    expect(reply.status).toBe(404)
    expect(reply.json()).toEqual({ error: '找不到这个产品' }) // the products route, looking for "a/b"
  })
})

describe('GET state', () => {
  it('lists tracks with their products, new and progress marks, candidates to look at, and today\'s numbers', async () => {
    const track = addTrack()
    const picking = addTrack({ name: '端侧 Agent', status: 'picking' })
    addProduct('p1', 'Cursor', 'tracking', track.id)
    addProduct('p2', 'Windsurf', 'tracking', track.id)
    addProduct('p3', 'Zed', 'baselining', track.id)
    addRun('baseline', { status: 'running', progress: { done: 2, total: 6 } }, TODAY, { productId: 'p3' })
    addRun('daily', { status: 'done', costYuan: 1.25 }, TODAY, { productId: 'p2' })
    addRun('daily', { status: 'done', costYuan: 9 }, '2026-11-24', { productId: 'p2' }) // yesterday's spending

    const unread = addFinding('p1')
    putBrief(TODAY, [unread.id, addFinding('p2', { read: true }).id], { minorIds: [addFinding('p2', { importance: 'minor' }).id] })
    for (const [name, tier] of [['豆包', 'strong'], ['Kimi', 'consider'], ['某硬件', 'excluded']] as const) {
      const p = addProduct(`c-${name}`, name, 'candidate')
      repo.addCandidate({ trackId: picking.id, batchId: 'b1', productId: p.id, tier, oneLiner: '', reason: '', heat: { foundCount: 1, datedWeekly: [], trend: 'unknown', showBars: false }, selected: tier === 'strong' })
    }

    const state = ok(await host.call('GET', 'state')).json<ApiResponse<'GET state'>>()
    expect(state.todayDate).toBe(TODAY)
    expect(state.tracks.map(t => [t.track.name, t.candidatesToReview])).toEqual([['AI 编程助手', 0], ['端侧 Agent', 2]])
    expect(state.tracks[0]!.products.map(p => [p.product.name, p.hasNew, p.progress])).toEqual([
      ['Cursor', true, null], ['Windsurf', false, null], ['Zed', false, { done: 2, total: 6 }],
    ])
    expect(state.todayUnread).toBe(1)
    expect(state.todayCostYuan).toBe(1.25)
    expect(state.browserAvailable).toBe(false)
  })

  it('counts unread like unreadCount, over the findings today\'s brief still shows', async () => {
    const track = addTrack()
    addProduct('p1', 'Cursor', 'tracking', track.id)
    const shown = [addFinding('p1'), addFinding('p1', { status: 'unconfirmed' }), addFinding('p1', { read: true })]
    // Listed when the brief was written, no longer shown since: never part of the number.
    const gone = [addFinding('p1', { status: 'withdrawn' }), addFinding('p1', { status: 'pending' }), addFinding('p1', { status: 'unproven' })]
    putBrief(TODAY, [...shown, ...gone].map(f => f.id), { minorIds: [addFinding('p1', { importance: 'minor' }).id] })

    const state = ok(await host.call('GET', 'state')).json<ApiResponse<'GET state'>>()
    const brief = repo.getBrief(TODAY)!
    const stillShown = new Map(brief.findingIds.map(id => repo.getFinding(id)!).filter(f => f.status === 'verified' || f.status === 'unconfirmed').map(f => [f.id, f]))
    expect(state.todayUnread).toBe(unreadCount(brief, stillShown))
    expect(state.todayUnread).toBe(2)

    await host.call('POST', `findings/${shown[0]!.id}/read`)
    expect(ok(await host.call('GET', 'state')).json<ApiResponse<'GET state'>>().todayUnread).toBe(1)
  })

  it('shows nothing unread on a day without a brief', async () => {
    addFinding('p1') // made today, but no brief lists it yet
    expect(ok(await host.call('GET', 'state')).json<ApiResponse<'GET state'>>().todayUnread).toBe(0)
  })

  it('says whether the browser fallback is on: DSH has browser use and a browser provider registered', async () => {
    const browser = async () => ok(await host.call('GET', 'state')).json<ApiResponse<'GET state'>>().browserAvailable
    expect(await browser()).toBe(false)
    host.services.browserUse = { providerName: undefined } // dsh-browser-use without a browser
    expect(await browser()).toBe(false)
    host.services.browserUse = { providerName: 'playwright-mcp' }
    expect(await browser()).toBe(true)
    expect(host.ctx.get).toHaveBeenCalledWith('browserUse')
  })
})

describe('GET brief', () => {
  let ids: Record<string, Id>
  let sources: Source[]
  beforeEach(() => {
    const track = addTrack()
    for (const [id, name] of [['p1', 'Cursor'], ['p2', 'Windsurf'], ['p3', 'Zed'], ['p4', 'Cline'], ['p5', '无关']]) addProduct(id!, name!, 'tracking', track.id)
    sources = [addSource('Cursor 发布'), addSource('Windsurf 涨价')]
    const f1 = addFinding('p1', { sourceIds: [sources[0]!.id] })
    const f2 = addFinding('p2', { status: 'unconfirmed', sourceIds: [sources[1]!.id] })
    const minor = addFinding('p1', { importance: 'minor' })
    const withdrawn = addFinding('p2', { status: 'withdrawn' })
    putBrief(TODAY, [f1.id, f2.id, withdrawn.id], { minorIds: [minor.id], quietProductIds: ['p3'], skipped: [{ productId: 'p4', reason: '今日总预算已用完' }] })
    putBrief('2026-11-23', [])
    putBrief('2026-11-20', [])
    ids = { f1: f1.id, f2: f2.id, minor: minor.id, withdrawn: withdrawn.id }
  })

  it('returns today\'s brief with the findings it shows, their products and sources, and the day before that has one', async () => {
    const view = ok(await host.call('GET', 'brief')).json<ApiResponse<'GET brief'>>()
    expect(view.brief).toMatchObject({ date: TODAY, findingIds: [ids.f1, ids.f2, ids.withdrawn], minorIds: [ids.minor] })
    expect(view.findings.map(f => f.id)).toEqual([ids.f1, ids.f2, ids.minor]) // the withdrawn one is no longer shown
    expect(view.products.map(p => p.id).sort()).toEqual(['p1', 'p2', 'p3', 'p4'])
    expect(view.sources).toEqual(sources)
    expect(view.prevDate).toBe('2026-11-23')
  })

  it('returns another day\'s brief, and an empty one for a day without', async () => {
    expect(ok(await host.call('GET', 'brief?date=2026-11-23')).json<ApiResponse<'GET brief'>>()).toMatchObject({ brief: { date: '2026-11-23' }, prevDate: '2026-11-20' })
    expect(ok(await host.call('GET', 'brief?date=2026-11-20')).json<ApiResponse<'GET brief'>>().prevDate).toBeNull()
    expect(ok(await host.call('GET', 'brief?date=2026-11-24')).json()).toEqual({ brief: null, findings: [], products: [], sources: [], prevDate: '2026-11-23' })
  })

  it('refuses a date that is not YYYY-MM-DD', async () => {
    for (const date of ['yesterday', '2026-11-5', '2026-13-01'])
      expect((await host.call('GET', `brief?date=${date}`)).status, date).toBe(400)
  })

  it('marks one finding read, and a whole day read', async () => {
    expect(ok(await host.call('POST', `findings/${ids.f1}/read`)).json()).toEqual({ ok: true })
    expect(repo.getFinding(ids.f1!)!.read).toBe(true)
    expect(repo.getFinding(ids.f2!)!.read).toBe(false)
    expect((await host.call('POST', 'findings/nope/read')).status).toBe(404)

    const other = addFinding('p1', {}, '2026-11-23')
    expect(ok(await host.call('POST', 'brief/read-all', { date: TODAY })).json()).toEqual({ ok: true })
    for (const id of [ids.f2, ids.minor, ids.withdrawn]) expect(repo.getFinding(id!)!.read).toBe(true)
    expect(repo.getFinding(other.id)!.read).toBe(false) // another day's
    expect((await host.call('POST', 'brief/read-all', { date: '2026-11-24' })).status).toBe(404)
    expect((await host.call('POST', 'brief/read-all', { date: 'today' })).status).toBe(400)
    expect((await host.call('POST', 'brief/read-all')).status).toBe(400)
  })
})

describe('POST tracks', () => {
  it('creates a track being picked with the six default dimensions and the custom ones, and starts its recommendation', async () => {
    const reply = ok(await host.call('POST', 'tracks', { name: '  AI 编程助手 ', brief: '盯住编程类 Agent', extraDimensions: ['定价模式'] }))
    const { trackId, batchId } = reply.json<ApiResponse<'POST tracks'>>()
    const track = repo.listTracks().find(t => t.id === trackId)!
    expect(track).toMatchObject({ name: 'AI 编程助手', brief: '盯住编程类 Agent', status: 'picking' })
    expect(track.dimensions).toEqual([...DEFAULT_DIMENSIONS, { key: slugDimension('定价模式'), label: '定价模式' }])
    expect(repo.getRun(batchId)).toMatchObject({ kind: 'recommend', trackId })
    await flush()
    expect(host.driver.runs.map(r => r.title)).toEqual(['前哨 · 推荐 AI 编程助手'])
  })

  it('refuses a name over 20, a brief over 100 and a blank dimension, and creates nothing', async () => {
    const valid = { name: 'AI 编程助手', brief: '', extraDimensions: [] as string[] }
    for (const body of [
      { ...valid, name: '一'.repeat(21) }, { ...valid, name: '  ' }, { ...valid, brief: '一'.repeat(101) },
      { ...valid, extraDimensions: ['定价', '   '] }, { ...valid, extraDimensions: '定价' }, { brief: '' }, undefined,
    ]) expect((await host.call('POST', 'tracks', body)).status, JSON.stringify(body)).toBe(400)
    expect(ok(await host.call('POST', 'tracks', { ...valid, name: '一'.repeat(20), brief: '一'.repeat(100) })).status).toBe(200)
    expect(repo.listTracks()).toHaveLength(1)
  })

  it('gives each custom dimension a key of its own: none clashes with a default, another custom one or another track\'s', async () => {
    const make = async (extraDimensions: string[]) => {
      const { trackId } = ok(await host.call('POST', 'tracks', { name: '赛道', brief: '', extraDimensions })).json<ApiResponse<'POST tracks'>>()
      return repo.listTracks().find(t => t.id === trackId)!.dimensions.slice(DEFAULT_DIMENSIONS.length)
    }
    const growth = slugDimension('用户增长与留存策略分析')
    expect(growth).toBe(slugDimension('用户增长与留存策略研究')) // the first 8 characters make the key
    expect(await make(['Experience', 'Pricing Model', 'pricing model', '用户增长与留存策略分析', '用户增长与留存策略研究', '定位', ' 社区 '])).toEqual([
      { key: 'experience-2', label: 'Experience' }, // 'experience' is 体验's
      { key: 'pricing-model', label: 'Pricing Model' }, // the same label twice is one dimension
      { key: growth, label: '用户增长与留存策略分析' },
      { key: `${growth}-2`, label: '用户增长与留存策略研究' },
      // '定位' is a default already
      { key: slugDimension('社区'), label: '社区' },
    ])
    // Another track: the same label is the same dimension (one card for a product in both); another label gets its own key.
    expect(await make(['用户增长与留存策略研究', '用户增长与留存策略总结'])).toEqual([
      { key: `${growth}-2`, label: '用户增长与留存策略研究' },
      { key: `${growth}-3`, label: '用户增长与留存策略总结' },
    ])
  })
})

describe('PATCH tracks/:id', () => {
  const create = async (extraDimensions: string[]) =>
    ok(await host.call('POST', 'tracks', { name: 'AI 编程助手', brief: '盯住编程类 Agent', extraDimensions })).json<ApiResponse<'POST tracks'>>().trackId
  const custom = (track: Track): Dimension[] => track.dimensions.slice(DEFAULT_DIMENSIONS.length)

  it('renames, rewrites the brief, and changes the custom dimensions, each kept one keeping its key', async () => {
    const id = await create(['用户增长与留存策略分析', '用户增长与留存策略研究'])
    const growth = slugDimension('用户增长与留存策略分析')
    const renamed = ok(await host.call('PATCH', `tracks/${id}`, { name: '编程 Agent' })).json<Track>()
    expect(renamed).toMatchObject({ id, name: '编程 Agent', brief: '盯住编程类 Agent' })
    expect(custom(renamed).map(d => d.key)).toEqual([growth, `${growth}-2`]) // untouched

    const changed = ok(await host.call('PATCH', `tracks/${id}`, { brief: '只看 IDE 类', extraDimensions: ['用户增长与留存策略研究', '定价'] })).json<Track>()
    expect(changed).toMatchObject({ name: '编程 Agent', brief: '只看 IDE 类' })
    expect(custom(changed)).toEqual([{ key: `${growth}-2`, label: '用户增长与留存策略研究' }, { key: slugDimension('定价'), label: '定价' }])
    expect(changed.dimensions.slice(0, DEFAULT_DIMENSIONS.length)).toEqual(DEFAULT_DIMENSIONS)
    expect(repo.listTracks().find(t => t.id === id)).toEqual(changed)
  })

  it('never hands a removed dimension\'s key, whose cards remain, to a new label', async () => {
    const id = await create(['用户增长与留存策略分析'])
    const growth = slugDimension('用户增长与留存策略分析')
    addProduct('p1', 'Cursor', 'tracking', id)
    card('p1', growth, 1, [])
    ok(await host.call('PATCH', `tracks/${id}`, { extraDimensions: [] }))
    const later = ok(await host.call('PATCH', `tracks/${id}`, { extraDimensions: ['用户增长与留存策略总结'] })).json<Track>()
    expect(custom(later)).toEqual([{ key: `${growth}-2`, label: '用户增长与留存策略总结' }]) // not the old card's key
  })

  it('refuses an unknown track and fields over their limits', async () => {
    const id = await create([])
    expect((await host.call('PATCH', 'tracks/nope', { name: '新名字' })).status).toBe(404)
    for (const body of [{ name: '一'.repeat(21) }, { brief: '一'.repeat(101) }, { extraDimensions: [''] }])
      expect((await host.call('PATCH', `tracks/${id}`, body)).status, JSON.stringify(body)).toBe(400)
    expect(repo.listTracks()[0]).toMatchObject({ name: 'AI 编程助手' })
  })
})

describe('recommendations', () => {
  it('starts a new batch with the user\'s request, refusing a second one while the first still runs', async () => {
    const first = gate()
    host.driver.script[RECOMMEND] = recommends([['Cursor', 'strong']], first.promise)
    const { trackId, batchId } = ok(await host.call('POST', 'tracks', { name: 'AI 编程助手', brief: '', extraDimensions: [] })).json<ApiResponse<'POST tracks'>>()
    await flush()

    const busy = await host.call('POST', `tracks/${trackId}/recommend`, { refine: '多找些国内的' })
    expect(busy.status).toBe(409)
    expect(busy.json()).toEqual({ error: '上一轮推荐还在进行，稍等它结束再调整' })
    expect(host.driver.runs).toHaveLength(1)

    first.open()
    await vi.waitFor(() => { expect(repo.getRun(batchId)!.status).toBe('done') })
    host.driver.script[RECOMMEND] = recommends([['Windsurf', 'strong']])
    const next = ok(await host.call('POST', `tracks/${trackId}/recommend`, { refine: '多找些国内的' })).json<ApiResponse<'POST tracks/:id/recommend'>>()
    expect(next.batchId).not.toBe(batchId)
    expect(repo.getRun(next.batchId)).toMatchObject({ kind: 'recommend', trackId })
    await vi.waitFor(() => { expect(host.driver.runs).toHaveLength(2) })
    expect(host.driver.runs[1]!.prompt).toContain('多找些国内的')
  })

  it('refuses a request over 60 characters and an unknown track; a request may be left out', async () => {
    const track = addTrack({ status: 'picking' })
    expect((await host.call('POST', `tracks/${track.id}/recommend`, { refine: '一'.repeat(61) })).status).toBe(400)
    expect((await host.call('POST', 'tracks/nope/recommend', {})).status).toBe(404)
    expect(ok(await host.call('POST', `tracks/${track.id}/recommend`)).json()).toHaveProperty('batchId')
  })

  it('shows the latest batch as it fills, whether it still runs, and how long it has taken', async () => {
    const rest = gate()
    host.driver.script[RECOMMEND] = async round => {
      await recommends([['Cursor', 'strong']], rest.promise)({ ...round, done: async () => undefined })
      await round.call('outpost_submit_candidate', {
        name: 'Windsurf', company: 'Windsurf Inc', region: 'overseas', form: 'IDE', oneLiner: 'AI 编辑器', tier: 'consider', reason: '也不错',
        articles: [{ url: 'https://example.com/w', title: 'Windsurf', publishedAt: null }],
      })
      await round.done()
      return completed()
    }
    const { trackId, batchId } = ok(await host.call('POST', 'tracks', { name: 'AI 编程助手', brief: '', extraDimensions: [] })).json<ApiResponse<'POST tracks'>>()
    await flush()
    const early = ok(await host.call('GET', `tracks/${trackId}/candidates`)).json<ApiResponse<'GET tracks/:id/candidates'>>()
    expect(early).toMatchObject({ batchId, running: true, elapsedSec: 0 })
    expect(early.candidates.map(c => [c.product.name, c.tier, c.batchId])).toEqual([['Cursor', 'strong', batchId]])

    host.clock.set('2026-11-25T07:02:10')
    expect(ok(await host.call('GET', `tracks/${trackId}/candidates`)).json<ApiResponse<'GET tracks/:id/candidates'>>().elapsedSec).toBe(130)
    rest.open()
    await vi.waitFor(() => { expect(repo.getRun(batchId)!.status).toBe('done') })
    host.clock.set('2026-11-25T07:30')
    const done = ok(await host.call('GET', `tracks/${trackId}/candidates`)).json<ApiResponse<'GET tracks/:id/candidates'>>()
    expect(done).toMatchObject({ batchId, running: false, elapsedSec: 130 }) // the time it took, not the time since
    expect(done.candidates.map(c => c.product.name)).toEqual(['Cursor', 'Windsurf'])
    expect((await host.call('GET', 'tracks/nope/candidates')).status).toBe(404)
  })
})

describe('POST tracks/:id/start', () => {
  it('activates the track, links the chosen products, records the choice, and baselines only the products new to Outpost', async () => {
    const other = addTrack({ name: '老赛道' })
    addProduct('p0', 'Cursor', 'tracking', other.id) // tracked already, in another track
    host.driver.script[RECOMMEND] = recommends([['Cursor', 'strong'], ['Windsurf', 'strong'], ['Zed', 'consider'], ['某硬件', 'excluded']])
    const { trackId, batchId } = ok(await host.call('POST', 'tracks', { name: '编程 Agent', brief: '', extraDimensions: [] })).json<ApiResponse<'POST tracks'>>()
    await vi.waitFor(() => { expect(repo.getRun(batchId)!.status).toBe('done') })
    const byName = new Map(repo.listCandidates(trackId).map(c => [repo.getProduct(c.productId)!.name, c]))
    expect(byName.get('Cursor')!.productId).toBe('p0') // the same product, not a copy
    expect(ok(await host.call('GET', 'state')).json<ApiResponse<'GET state'>>().tracks.find(t => t.track.id === trackId)!.candidatesToReview).toBe(3)

    const chosen = [byName.get('Cursor')!.id, byName.get('Windsurf')!.id]
    expect(ok(await host.call('POST', `tracks/${trackId}/start`, { candidateIds: chosen })).json()).toEqual({ ok: true })

    expect(repo.listTracks().find(t => t.id === trackId)!.status).toBe('active')
    expect(repo.productsOfTrack(trackId).map(p => p.name)).toEqual(['Cursor', 'Windsurf'])
    expect(repo.listCandidates(trackId).map(c => [repo.getProduct(c.productId)!.name, c.selected])).toEqual([
      ['Cursor', true], ['Windsurf', true], ['Zed', false], ['某硬件', false],
    ])
    const windsurf = byName.get('Windsurf')!.productId
    expect(repo.getProduct(windsurf)!.status).toBe('baselining') // 建档中 at once
    expect(repo.getProduct('p0')!.status).toBe('tracking')
    await vi.waitFor(() => { expect(host.driver.runs.map(r => r.title)).toContain('前哨 · Windsurf 建档') })
    await flush()
    // Cursor is tracked already: its daily run (and the scheduler) fill in what the new track adds, not a baseline beside it.
    expect(host.driver.runs.filter(r => r.sessionId.startsWith(BASELINE)).map(r => r.title)).toEqual(['前哨 · Windsurf 建档'])
    // What was not picked is not waiting to be looked at any more.
    expect(ok(await host.call('GET', 'state')).json<ApiResponse<'GET state'>>().tracks.find(t => t.track.id === trackId)!.candidatesToReview).toBe(0)
  })

  it('refuses no candidates, a candidate of another track and an unknown track', async () => {
    const track = addTrack({ status: 'picking' })
    const elsewhere = addTrack({ status: 'picking' })
    const p = addProduct('c1', '豆包', 'candidate')
    const foreign = repo.addCandidate({ trackId: elsewhere.id, batchId: 'b9', productId: p.id, tier: 'strong', oneLiner: '', reason: '', heat: { foundCount: 1, datedWeekly: [], trend: 'unknown', showBars: false }, selected: true })
    expect((await host.call('POST', `tracks/${track.id}/start`, { candidateIds: [] })).status).toBe(400)
    expect((await host.call('POST', `tracks/${track.id}/start`, {})).status).toBe(400)
    expect((await host.call('POST', `tracks/${track.id}/start`, { candidateIds: [foreign.id] })).status).toBe(400)
    expect((await host.call('POST', 'tracks/nope/start', { candidateIds: [foreign.id] })).status).toBe(404)
    expect(repo.listTracks().find(t => t.id === track.id)!.status).toBe('picking')
    expect(repo.getProduct('c1')!.status).toBe('candidate')
  })
})

describe('products', () => {
  it('returns the dossier: latest cards, each dimension\'s history, the cards\' sources, facts and dimensions', async () => {
    const track = addTrack({ dimensions: [{ key: 'positioning', label: '定位' }, { key: 'business', label: '商业化' }] })
    addProduct('p1', 'Cursor', 'tracking', track.id)
    const [s1, s2] = [addSource('Cursor 官网'), addSource('Cursor 定价')]
    card('p1', 'positioning', 1, [s1!.id])
    card('p1', 'positioning', 2, [s1!.id, s2!.id], '补充了 Agent 模式')
    card('p1', 'business', 1, [s2!.id])
    repo.addFacts({ productId: 'p1', form: 'IDE', platforms: 'macOS、Windows', price: '20 美元/月', firstReleased: '2023', rivals: ['Windsurf'] })

    const view = ok(await host.call('GET', 'products/p1')).json<ApiResponse<'GET products/:id'>>()
    expect(view.product).toMatchObject({ id: 'p1', name: 'Cursor' })
    expect(view.facts).toMatchObject({ price: '20 美元/月', version: 1 })
    expect(view.cards.map(c => [c.dimension, c.version])).toEqual([['positioning', 2], ['business', 1]])
    expect(view.history).toEqual({
      positioning: [{ version: 1, changeNote: '建档', createdAt: '2026-11-21T00:00:00.000Z' }, { version: 2, changeNote: '补充了 Agent 模式', createdAt: '2026-11-22T00:00:00.000Z' }],
      business: [{ version: 1, changeNote: '建档', createdAt: '2026-11-21T00:00:00.000Z' }],
    })
    expect(view.sources).toEqual([s1, s2])
    expect(view.dimensions).toEqual(track.dimensions)
    expect(view.progress).toBeNull()
    expect((await host.call('GET', 'products/nope')).status).toBe(404)
  })

  it('shows the progress of a product being baselined, and an empty dossier', async () => {
    const track = addTrack()
    addProduct('p1', 'Cursor', 'baselining', track.id)
    addRun('baseline', { status: 'done', progress: { done: 6, total: 6 } }, '2026-11-20', { productId: 'p1' }) // an older one
    addRun('baseline', { status: 'running', progress: { done: 1, total: 6 } }, TODAY, { productId: 'p1' })
    const view = ok(await host.call('GET', 'products/p1')).json<ApiResponse<'GET products/:id'>>()
    expect(view).toMatchObject({ facts: null, cards: [], sources: [], progress: { done: 1, total: 6 } })
    expect(Object.keys(view.history)).toEqual(DEFAULT_DIMENSIONS.map(d => d.key))
    expect(Object.values(view.history).every(h => h.length === 0)).toBe(true)
  })

  it('lists the product\'s findings newest first, leaving out those not checked yet and those withdrawn', async () => {
    addProduct('p1', 'Cursor')
    addProduct('p2', 'Windsurf')
    const s = addSource('Cursor 发布')
    const old = addFinding('p1', { sourceIds: [s.id] }, '2026-11-20')
    const unconfirmed = addFinding('p1', { status: 'unconfirmed' })
    const unproven = addFinding('p1', { status: 'unproven' })
    addFinding('p1', { status: 'pending' })
    addFinding('p1', { status: 'withdrawn' })
    addFinding('p2')
    const view = ok(await host.call('GET', 'products/p1/findings')).json<ApiResponse<'GET products/:id/findings'>>()
    expect(view.findings.map(f => f.id)).toEqual([unproven.id, unconfirmed.id, old.id])
    expect(view.sources).toEqual([s])
    expect((await host.call('GET', 'products/nope/findings')).status).toBe(404)
  })

  it('pauses and resumes tracking, and sets or clears the product\'s own daily budget', async () => {
    addProduct('p1', 'Cursor')
    expect(ok(await host.call('PATCH', 'products/p1', { status: 'paused' })).json()).toMatchObject({ id: 'p1', status: 'paused', dailyBudgetYuan: null })
    expect(ok(await host.call('PATCH', 'products/p1', { dailyBudgetYuan: 2.5 })).json()).toMatchObject({ status: 'paused', dailyBudgetYuan: 2.5 })
    expect(ok(await host.call('PATCH', 'products/p1', { status: 'tracking', dailyBudgetYuan: null })).json()).toMatchObject({ status: 'tracking', dailyBudgetYuan: null })
    expect(repo.getProduct('p1')).toMatchObject({ status: 'tracking', dailyBudgetYuan: null })
  })

  it('refuses to pause a product not tracked yet, and values out of range', async () => {
    addProduct('p1', 'Cursor', 'baselining')
    addProduct('p2', 'Windsurf')
    const busy = await host.call('PATCH', 'products/p1', { status: 'paused' })
    expect(busy.status).toBe(409)
    for (const body of [{ status: 'archived' }, { dailyBudgetYuan: -1 }, { dailyBudgetYuan: '5' }])
      expect((await host.call('PATCH', 'products/p2', body)).status, JSON.stringify(body)).toBe(400)
    expect((await host.call('PATCH', 'products/nope', { status: 'paused' })).status).toBe(404)
    expect(repo.getProduct('p1')!.status).toBe('baselining')
    expect(repo.getProduct('p2')).toMatchObject({ status: 'tracking', dailyBudgetYuan: null })
  })
})

describe('POST products/:id/update-now', () => {
  let track: Track
  beforeEach(() => {
    track = addTrack({ dimensions: [{ key: 'positioning', label: '定位' }] })
    addProduct('p1', 'Cursor', 'tracking', track.id)
    card('p1', 'positioning', 1, [])
  })

  it('answers at once with the update\'s run, while it still runs', async () => {
    const held = gate()
    host.driver.script[DAILY] = holds(held.promise)
    const { runId } = ok(await host.call('POST', 'products/p1/update-now')).json<ApiResponse<'POST products/:id/update-now'>>()
    expect(repo.getRun(runId)).toMatchObject({ kind: 'daily', productId: 'p1', date: TODAY })
    expect(['queued', 'running']).toContain(repo.getRun(runId)!.status)

    // Asked again while it runs: the same run, not a second session.
    expect(ok(await host.call('POST', 'products/p1/update-now')).json()).toEqual({ runId })
    held.open()
    await vi.waitFor(() => { expect(repo.getRun(runId)!.status).toBe('done') })
    expect(host.driver.runs.filter(r => r.sessionId.startsWith(DAILY))).toHaveLength(1)
  })

  it('answers with the baseline that fills in a missing card first', async () => {
    repo.updateTrack(track.id, { dimensions: [{ key: 'positioning', label: '定位' }, { key: 'business', label: '商业化' }] })
    host.driver.script[BASELINE] = holds(new Promise(() => {}))
    const { runId } = ok(await host.call('POST', 'products/p1/update-now')).json<ApiResponse<'POST products/:id/update-now'>>()
    expect(repo.getRun(runId)).toMatchObject({ kind: 'baseline', productId: 'p1' })
  })

  it('refuses a product that is not tracked, and an unknown one', async () => {
    addProduct('c1', '豆包', 'candidate')
    addProduct('p2', 'Windsurf', 'paused', track.id)
    for (const id of ['c1', 'p2']) {
      const reply = await host.call('POST', `products/${id}/update-now`)
      expect(reply.status, id).toBe(409)
      expect(reply.json()).toEqual({ error: '这个产品没有在跟踪，先恢复跟踪再更新' })
    }
    expect((await host.call('POST', 'products/nope/update-now')).status).toBe(404)
    await flush()
    expect(host.driver.runs).toEqual([])
  })
})

describe('GET icons/:productId', () => {
  const icon = (name: string, bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])) => {
    mkdirSync(join(host.dataDir, 'icons'), { recursive: true })
    const path = join(host.dataDir, 'icons', name)
    writeFileSync(path, bytes)
    return path
  }

  it('serves the stored icon with its type, cached for a day', async () => {
    addProduct('p1', 'Cursor')
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9])
    repo.setProductIcon('p1', icon('p1.jpg', bytes))
    const reply = ok(await host.call('GET', 'icons/p1'))
    expect(reply.headers).toMatchObject({ 'content-type': 'image/jpeg', 'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff' })
    expect(Buffer.compare(reply.body, bytes)).toBe(0)
  })

  it('answers 404 when there is no icon or its file is gone, so the panel shows the tile', async () => {
    addProduct('p1', 'Cursor')
    expect((await host.call('GET', 'icons/p1')).status).toBe(404)
    repo.setProductIcon('p1', join(host.dataDir, 'icons', 'p1.png')) // never written
    expect((await host.call('GET', 'icons/p1')).status).toBe(404)
    expect((await host.call('GET', 'icons/nope')).status).toBe(404)
  })

  it('serves nothing from outside the icons folder, and no type it does not keep', async () => {
    addProduct('p1', 'Cursor')
    addProduct('p2', 'Windsurf')
    icon('p2.png')
    repo.setProductIcon('p1', join(host.dataDir, 'outpost.sqlite'))
    expect((await host.call('GET', 'icons/p1')).status).toBe(404)
    const outside = join(host.dir, 'p1.png') // a real image, beside the data directory
    writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    repo.setProductIcon('p1', outside)
    expect((await host.call('GET', 'icons/p1')).status).toBe(404)
    repo.setProductIcon('p1', icon('p2.png')) // another product's file
    expect((await host.call('GET', 'icons/p1')).status).toBe(404)
    repo.setProductIcon('p1', icon('p1.svg'))
    expect((await host.call('GET', 'icons/p1')).status).toBe(404)
    expect((await host.call('GET', 'icons/..%2Foutpost.sqlite')).status).toBe(404)
  })
})

describe('POST followup', () => {
  it('opens the follow-up chat about a finding and answers with its session', async () => {
    addProduct('p1', 'Cursor')
    const finding = addFinding('p1')
    const { sessionId } = ok(await host.call('POST', 'followup', { findingId: finding.id })).json<ApiResponse<'POST followup'>>()
    expect(sessionId).toMatch(/^outpost-followup-[0-9a-f-]{8}$/)
    expect(host.driver.interactive.map(s => [s.sessionId, s.title])).toEqual([[sessionId, '追问 · Cursor 后台 Agent 正式上线']])
  })

  it('refuses an unknown finding and a missing one', async () => {
    expect((await host.call('POST', 'followup', { findingId: 'nope' })).status).toBe(404)
    expect((await host.call('POST', 'followup', {})).status).toBe(400)
    expect(host.driver.interactive).toEqual([])
  })
})

describe('runs', () => {
  it('lists the runs of the last 7 days, newest first, with the product\'s name', async () => {
    addProduct('p1', 'Cursor')
    const track = addTrack()
    const old = addRun('daily', { status: 'done' }, '2026-11-18', { productId: 'p1' })
    const weekAgo = addRun('daily', { status: 'failed', error: '网络错误' }, '2026-11-19', { productId: 'p1' })
    const recommend = addRun('recommend', { status: 'done' }, TODAY, { trackId: track.id })
    const noted = addRun('daily', { status: 'done', error: '提醒后仍没有调用 outpost_done，按已提交的内容收尾' }, TODAY, { productId: 'p1' })

    const { runs } = ok(await host.call('GET', 'runs')).json<ApiResponse<'GET runs'>>()
    expect(runs.map(r => r.id)).toEqual([noted.id, recommend.id, weekAgo.id])
    expect(runs.map(r => r.productName)).toEqual(['Cursor', null, 'Cursor'])
    expect(runs[0]).toMatchObject({ status: 'done', error: '提醒后仍没有调用 outpost_done，按已提交的内容收尾' }) // a note on a finished run
    expect(runs.some(r => r.id === old.id)).toBe(false)

    expect(ok(await host.call('GET', 'runs?days=1')).json<ApiResponse<'GET runs'>>().runs.map(r => r.id)).toEqual([noted.id, recommend.id])
    expect(ok(await host.call('GET', 'runs?days=8')).json<ApiResponse<'GET runs'>>().runs).toHaveLength(4)
    for (const days of ['0', 'abc', '1.5', '400']) expect((await host.call('GET', `runs?days=${days}`)).status, days).toBe(400)
  })

  it('retries a failed daily update as an update now, answering with the new run', async () => {
    const track = addTrack({ dimensions: [{ key: 'positioning', label: '定位' }] })
    addProduct('p1', 'Cursor', 'tracking', track.id)
    card('p1', 'positioning', 1, [])
    const failed = addRun('daily', { status: 'failed', error: '网络错误' }, '2026-11-24', { productId: 'p1' })
    const { runId } = ok(await host.call('POST', `runs/${failed.id}/retry`)).json<ApiResponse<'POST runs/:id/retry'>>()
    expect(runId).not.toBe(failed.id)
    expect(repo.getRun(runId)).toMatchObject({ kind: 'daily', productId: 'p1', date: TODAY })
  })

  it('retries a failed recommendation as a new batch, and a failed baseline as a new baseline', async () => {
    const track = addTrack({ status: 'picking' })
    const recommend = addRun('recommend', { status: 'failed', error: '模型出错' }, TODAY, { trackId: track.id })
    const batch = ok(await host.call('POST', `runs/${recommend.id}/retry`)).json<ApiResponse<'POST runs/:id/retry'>>().runId
    expect(repo.getRun(batch)).toMatchObject({ kind: 'recommend', trackId: track.id })
    expect(batch).not.toBe(recommend.id)

    addProduct('p1', 'Cursor', 'baselining', track.id)
    const baseline = addRun('baseline', { status: 'failed', error: '没有提交任何档案卡' }, TODAY, { productId: 'p1' })
    const again = ok(await host.call('POST', `runs/${baseline.id}/retry`)).json<ApiResponse<'POST runs/:id/retry'>>().runId
    expect(repo.getRun(again)).toMatchObject({ kind: 'baseline', productId: 'p1' })
    expect(again).not.toBe(baseline.id)
  })

  it('retries a failed summary by writing the day\'s brief again', async () => {
    addProduct('p1', 'Cursor')
    const finding = addFinding('p1')
    putBrief(TODAY, [finding.id], { gist: 'Cursor：后台 Agent 正式上线' })
    const failed = addRun('synthesize', { status: 'failed', error: 'HTTP 503' })
    host.complete.mockResolvedValueOnce({ text: 'Cursor 的后台 Agent 正式上线。', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } })
    const { runId } = ok(await host.call('POST', `runs/${failed.id}/retry`)).json<ApiResponse<'POST runs/:id/retry'>>()
    expect(repo.getRun(runId)).toMatchObject({ kind: 'synthesize', date: TODAY })
    expect(runId).not.toBe(failed.id)
    await vi.waitFor(() => { expect(repo.getBrief(TODAY)!.gist).toBe('Cursor 的后台 Agent 正式上线。') })
  })

  it('refuses a run that did not fail, a follow-up chat, and an unknown run', async () => {
    addProduct('p1', 'Cursor')
    const done = addRun('daily', { status: 'done' }, TODAY, { productId: 'p1' })
    const skipped = addRun('daily', { status: 'skipped', error: '今日总预算已用完' }, TODAY, { productId: 'p1' })
    const followup = addRun('followup', { status: 'failed', error: 'DSH 没有响应' }, TODAY, { productId: 'p1' })
    for (const run of [done, skipped]) {
      const reply = await host.call('POST', `runs/${run.id}/retry`)
      expect(reply.status).toBe(409)
      expect(reply.json()).toEqual({ error: '只有失败的运行可以重试' })
    }
    expect((await host.call('POST', `runs/${followup.id}/retry`)).status).toBe(409)
    expect((await host.call('POST', 'runs/nope/retry')).status).toBe(404)
    await flush()
    expect(host.driver.runs).toEqual([])
  })
})
