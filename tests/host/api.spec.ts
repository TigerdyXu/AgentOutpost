import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config } from '../../src/config.ts'
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
const IDENTIFY = 'outpost-identify-'

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
/**
 * A product row of its own spelling, beside rows that read alike: what a database made before alike spellings were one
 * product holds. The row is made under another name, then renamed by id, which `upsertProduct` allows.
 */
const addAlike = (id: Id, name: string, company: string, status: ProductStatus, trackId?: Id) => {
  addProduct(id, `row-${id}`, status, trackId)
  return repo.upsertProduct({ id, name, company, region: 'overseas', form: 'App', iconPath: null, officialDomains: [], status, dailyBudgetYuan: null })
}
/** A candidate of the track pointing at the product, in a batch of its own. */
const addCandidate = (trackId: Id, productId: Id) => repo.addCandidate({
  trackId, batchId: `batch-${trackId}`, productId, tier: 'strong', oneLiner: '', reason: '',
  heat: { foundCount: 1, datedWeekly: [], trend: 'unknown', showBars: false }, selected: true,
})
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
/** The dimension keys a baseline prompt asks for: its `- key：label` lines naming one of `known`. */
const askedFor = (prompt: string, known: string[]) => [...prompt.matchAll(/^- ([\w-]+)：/gm)].map(m => m[1]!).filter(key => known.includes(key))
/**
 * A baseline agent that hands in a card for every dimension of `known` its prompt asks for, once `until` opens (or at
 * once), and a checker that finds every quote: a baseline that ends with the product tracked.
 */
const baselines = (known: string[], until?: Promise<void>): Play => async round => {
  await until
  for (const dimension of askedFor(round.text, known)) {
    await round.call('outpost_submit_card', {
      dimension, summary: '面向开发者的 AI 编辑器', bullets: ['基于 VS Code'], body: '基于 VS Code 的编辑器[1]。',
      sources: [{ url: 'https://windsurf.com/', title: 'Windsurf 官网', publisher: 'Windsurf', publishedAt: null, kind: 'official', isOfficial: true, quote: 'The AI IDE' }],
    })
  }
  await round.done('建档完成')
  return completed()
}
const checksAll: Play = async round => {
  const pending = await round.call('outpost_read_pending') as Record<string, { sources: { sourceId: string; needsCheck: boolean }[] }[]>
  for (const source of Object.values(pending).flat().flatMap(item => item.sources).filter(s => s.needsCheck))
    await round.call('outpost_report_check', { sourceId: source.sourceId, openedVia: 'http', quoteFound: true, supportsClaim: true })
  await round.done()
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

  it('refuses a change not sent as JSON (415) and does nothing, while reads need no content type', async () => {
    const reply = await host.call('POST', 'tracks', JSON.stringify({ name: 'AI 编程助手', brief: '', extraDimensions: [] }), { 'content-type': 'text/plain' })
    expect(reply.status).toBe(415)
    expect(reply.json()).toEqual({ error: '请求必须是 JSON' })
    addProduct('p1', 'Cursor')
    const finding = addFinding('p1')
    expect((await host.call('POST', `findings/${finding.id}/read`, undefined, {})).status).toBe(415) // no body, no type: still refused
    await flush()
    expect(repo.listTracks()).toEqual([])
    expect(repo.getFinding(finding.id)!.read).toBe(false)
    expect(host.driver.runs).toEqual([])
    expect(ok(await host.call('GET', 'state', undefined, {})).json()).toHaveProperty('tracks', [])
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
    expect(state.researchBroken).toBe(false)
    // The time the daily run is due, for the page that says when the first brief will arrive.
    expect(state.runTime).toBe(rt.settings().runTime)
    expect(state.runTime).toMatch(/^\d\d:\d\d$/)
    // Where the data lives, for 设置 to show: DSH's configuration form carries only the fields that can change while running.
    expect(state.dataDir).toBe(host.dataDir)
  })

  it('says per track whether a recommendation for it is queued or running', async () => {
    const idle = addTrack({ name: '没跑的', status: 'picking' })
    const running = addTrack({ name: '在跑的', status: 'picking' })
    const queued = addTrack({ name: '排队的', status: 'picking' })
    const finished = addTrack({ name: '跑完的', status: 'picking' })
    const failed = addTrack({ name: '失败的', status: 'picking' })
    const retried = addTrack({ name: '重新推荐的', status: 'picking' })
    addRun('recommend', { status: 'running' }, TODAY, { trackId: running.id })
    addRun('recommend', { status: 'queued' }, TODAY, { trackId: queued.id })
    addRun('recommend', { status: 'done' }, TODAY, { trackId: finished.id })
    addRun('recommend', { status: 'failed', error: '会话出错' }, TODAY, { trackId: failed.id })
    // Only the track's latest recommendation counts: an earlier one still marked running does not.
    addRun('recommend', { status: 'running' }, TODAY, { trackId: retried.id })
    addRun('recommend', { status: 'done' }, TODAY, { trackId: retried.id })
    // Another kind of run for the track is not a recommendation.
    addRun('baseline', { status: 'running' }, TODAY, { trackId: idle.id })

    const { tracks } = ok(await host.call('GET', 'state')).json<ApiResponse<'GET state'>>()
    expect(tracks.map(t => [t.track.name, t.track.status, t.recommending])).toEqual([
      ['没跑的', 'picking', false], ['在跑的', 'picking', true], ['排队的', 'picking', true],
      ['跑完的', 'picking', false], ['失败的', 'picking', false], ['重新推荐的', 'picking', false],
    ])
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

  it('says when research cannot run because its preset does not compose, apart from whether the browser is on', async () => {
    const state = async () => ok(await host.call('GET', 'state')).json<ApiResponse<'GET state'>>()
    const presets = host.services.agentPresets as { resolve: ReturnType<typeof vi.fn>; inspectCompositions: ReturnType<typeof vi.fn> }
    expect(await state()).toMatchObject({ researchBroken: false })
    // The browser packages are missing: DSH marks the preset broken, and no research session can start.
    presets.resolve.mockResolvedValueOnce({ id: 'outpost-researcher', broken: 'browser-use-playwright: Cannot find package' })
    expect(await state()).toMatchObject({ researchBroken: true, browserAvailable: false })
    expect(presets.resolve).toHaveBeenCalledWith('outpost-researcher')
    // A Playwright browser for the whole profile beside the preset's own: a conflict, not 「on」.
    presets.inspectCompositions.mockReturnValue([{ id: 'outpost-researcher', modules: [{ moduleName: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', useHostBase: true }], leakedServices: [] }])
    expect(await state()).toMatchObject({ researchBroken: false, browserAvailable: true })
    host.services.browserUse = { providerName: 'playwright-mcp' }
    expect(await state()).toMatchObject({ researchBroken: true, browserAvailable: false })
  })
})

describe('GET models', () => {
  it('returns the groups and the default model', async () => {
    host.ctx.llm.listProviders.mockReturnValue([{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'ollama', name: 'Ollama' }, { id: 'anthropic', name: 'Anthropic' }])
    host.ctx.llm.listModels.mockImplementation(async provider => {
      if (provider === 'ollama') throw new Error('connect ECONNREFUSED 127.0.0.1:11434') // Ollama is not running
      return provider === 'anthropic'
        ? [{ provider, id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }]
        : [{ provider, id: 'deepseek-flash', name: 'DeepSeek Flash' }, { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]
    })
    host.ctx.agentDefaultModel.currentSelection.mockReturnValue({ provider: 'ollama', model: 'qwen3:8b', reasoningEffort: 'high' })

    const view = ok(await host.call('GET', 'models')).json<ApiResponse<'GET models'>>()

    expect(view).toEqual({
      groups: [
        { provider: 'deepseek-official', name: 'DeepSeek', billing: 'metered', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }], error: null },
        { provider: 'ollama', name: 'Ollama', billing: 'local', models: [], error: '读取失败' },
        { provider: 'anthropic', name: 'Anthropic', billing: 'subscription', models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' }], error: null },
      ],
      // Only which model: the reasoning effort is DSH's business.
      defaultModel: { provider: 'ollama', model: 'qwen3:8b' },
    })

    // DSH cannot say what its default model is: none is named, and the list still comes.
    host.ctx.agentDefaultModel.currentSelection.mockImplementation(() => { throw new Error('no default model') })
    const without = ok(await host.call('GET', 'models')).json<ApiResponse<'GET models'>>()
    expect(without.defaultModel).toBeNull()
    expect(without.groups).toHaveLength(3)
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
    expect(ok(await host.call('GET', 'brief?date=2026-11-24')).json()).toEqual({ brief: null, findings: [], products: [], sources: [], changed: {}, prevDate: '2026-11-23' })
  })

  it('says which dimensions each finding actually changed: those whose card a version of it cites, not the ones it names', async () => {
    // f names 定位, 商业化 and 体验, but the check let through only edits of 体验 and 商业化 resting on it (and one of 体验
    // resting on the minor update as well): those it names come first, in its order; 定位 is not claimed.
    const f = addFinding('p1', { dimensions: ['positioning', 'business', 'experience'] })
    const minor = addFinding('p1', { importance: 'minor', dimensions: [] })
    putBrief(TODAY, [f.id, ids.f2!], { minorIds: [minor.id] })
    for (const dimension of ['positioning', 'business', 'experience']) card('p1', dimension, 1, [])
    repo.addCardVersion({ ...repo.latestCards('p1').find(c => c.dimension === 'experience')!, version: 2, findingIds: [minor.id, f.id] })
    repo.addCardVersion({ ...repo.latestCards('p1').find(c => c.dimension === 'business')!, version: 2, findingIds: [f.id] })
    const view = ok(await host.call('GET', 'brief')).json<ApiResponse<'GET brief'>>()
    expect(view.changed).toEqual({ [f.id]: ['business', 'experience'], [minor.id]: ['experience'] })
    const feed = ok(await host.call('GET', 'products/p1/findings')).json<ApiResponse<'GET products/:id/findings'>>()
    expect(feed.changed).toEqual({ [f.id]: ['business', 'experience'], [minor.id]: ['experience'] })
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

  it('fills in a dimension the user adds at once for the track\'s tracked products, whatever the 7-day window', async () => {
    const id = await create([])
    addProduct('p1', 'Cursor', 'tracking', id)
    addProduct('p2', 'Windsurf', 'paused', id)
    addProduct('p3', 'Zed', 'tracking', id)
    for (const dim of DEFAULT_DIMENSIONS) { card('p1', dim.key, 1, []); card('p2', dim.key, 1, []); card('p3', dim.key, 1, []) }
    const community = { key: slugDimension('社区'), label: '社区' }
    repo.linkProduct(addTrack({ name: '开源', dimensions: [...DEFAULT_DIMENSIONS, community] }).id, 'p3')
    card('p3', community.key, 1, []) // Zed has that card already, from another track with the same dimension
    addRun('baseline', { status: 'done', startedAt: '2026-11-24T08:00:00.000Z', endedAt: '2026-11-24T08:20:00.000Z' }, '2026-11-24', { productId: 'p1' })

    ok(await host.call('PATCH', `tracks/${id}`, { name: '编程 Agent' })) // nothing new: nothing to fill in
    await flush()
    expect(host.driver.runs.filter(r => r.sessionId.startsWith(BASELINE))).toEqual([])

    ok(await host.call('PATCH', `tracks/${id}`, { extraDimensions: ['社区'] }))
    await vi.waitFor(() => { expect(host.driver.runs.filter(r => r.sessionId.startsWith(BASELINE)).map(r => r.title)).toEqual(['前哨 · Cursor 建档']) })
    const prompt = host.driver.runs.find(r => r.title === '前哨 · Cursor 建档')!.prompt
    expect(prompt).toContain(`- ${community.key}：社区`) // asks for the new one only
    expect(prompt).not.toContain('- audience：目标人群')
    await flush()
    expect(host.driver.runs.filter(r => r.sessionId.startsWith(BASELINE))).toHaveLength(1) // not the paused one, not Zed
  })

  it('fills in a dimension added while a product is still in 建档中, once its baseline is over', async () => {
    const held = gate()
    host.driver.script[RECOMMEND] = recommends([['Windsurf', 'strong']])
    const known = [...DEFAULT_DIMENSIONS.map(d => d.key), slugDimension('社区')]
    host.driver.script[BASELINE] = baselines(known, held.promise)
    host.driver.script['outpost-verify-'] = checksAll
    const id = await create([])
    await vi.waitFor(() => { expect(repo.listCandidates(id)).toHaveLength(1) })
    ok(await host.call('POST', `tracks/${id}/start`, { candidateIds: repo.listCandidates(id).map(c => c.id) }))
    const windsurf = repo.listCandidates(id)[0]!.productId
    await vi.waitFor(() => { expect(host.driver.runs.map(r => r.title)).toEqual(['前哨 · 推荐 AI 编程助手', '前哨 · Windsurf 建档']) })

    ok(await host.call('PATCH', `tracks/${id}`, { extraDimensions: ['社区'] })) // while its baseline (of the six) still runs
    await flush()
    const baselineRuns = () => host.driver.runs.filter(r => r.sessionId.startsWith(BASELINE))
    expect(baselineRuns()).toHaveLength(1) // nothing beside it

    held.open()
    await vi.waitFor(() => { expect(baselineRuns()).toHaveLength(2) })
    const asked = (n: number) => askedFor(baselineRuns()[n]!.prompt, known)
    expect(asked(0)).toEqual(DEFAULT_DIMENSIONS.map(d => d.key))
    expect(asked(1)).toEqual([slugDimension('社区')]) // only the new one
    await vi.waitFor(() => { expect(repo.latestCards(windsurf).map(c => c.dimension)).toContain(slugDimension('社区')) })
    expect(repo.getProduct(windsurf)!.status).toBe('tracking')
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
    expect(early).toMatchObject({ batchId, running: true, status: 'running', error: null, elapsedSec: 0 })
    expect(early.candidates.map(c => [c.product.name, c.tier, c.batchId])).toEqual([['Cursor', 'strong', batchId]])

    host.clock.set('2026-11-25T07:02:10')
    expect(ok(await host.call('GET', `tracks/${trackId}/candidates`)).json<ApiResponse<'GET tracks/:id/candidates'>>().elapsedSec).toBe(130)
    rest.open()
    await vi.waitFor(() => { expect(repo.getRun(batchId)!.status).toBe('done') })
    host.clock.set('2026-11-25T07:30')
    const done = ok(await host.call('GET', `tracks/${trackId}/candidates`)).json<ApiResponse<'GET tracks/:id/candidates'>>()
    expect(done).toMatchObject({ batchId, running: false, status: 'done', error: null, elapsedSec: 130 }) // the time it took, not the time since
    expect(done.candidates.map(c => c.product.name)).toEqual(['Cursor', 'Windsurf'])
    expect((await host.call('GET', 'tracks/nope/candidates')).status).toBe(404)
  })
})

describe('the candidates of a track that other tracks already follow', () => {
  const candidatesOf = async (trackId: Id) =>
    ok(await host.call('GET', `tracks/${trackId}/candidates`)).json<ApiResponse<'GET tracks/:id/candidates'>>().candidates

  it('lists the other tracks a candidate is already tracked in', async () => {
    const a = addTrack({ name: 'Personal Agent' })
    const c = addTrack({ name: 'AI 硬件' })
    const old = addTrack({ name: '旧赛道', status: 'archived' })
    const b = addTrack({ name: '手机 AI 助理', status: 'picking' })
    // 小豆, one tracked product, is linked into A and into C: both are told, in the order the tracks are listed. B follows it
    // too, but that is this track.
    addProduct('xiaodou', '小豆', 'tracking', a.id)
    repo.linkProduct(c.id, 'xiaodou')
    repo.linkProduct(b.id, 'xiaodou')
    // A product with a row of its own that reads alike: tracked in A as 「千问Go!」, a candidate here as 「千问Go」.
    addAlike('qwen-tracked', '千问Go!', '阿里巴巴', 'tracking', a.id)
    addAlike('qwen-copy', '千问Go', '阿里巴巴', 'candidate')
    addProduct('cursor', 'Cursor', 'candidate')
    // Followed only by a track that is archived, and a twin that is only a candidate elsewhere: nothing is being done for either.
    addProduct('retired', '老产品', 'tracking', old.id)
    addAlike('zed', 'Zed', 'Zed Inc', 'candidate', c.id)
    addAlike('zed-copy', 'Zed!', 'Zed Inc', 'candidate')
    for (const id of ['xiaodou', 'qwen-copy', 'cursor', 'retired', 'zed-copy']) addCandidate(b.id, id)

    const found = await candidatesOf(b.id)

    expect(found.map(f => [f.product.name, f.trackedIn, f.trackedStatus])).toEqual([
      ['小豆', ['Personal Agent', 'AI 硬件'], 'tracking'],
      ['千问Go', ['Personal Agent'], 'tracking'], // the status of the tracked twin, not of the candidate row
      ['Cursor', [], null],
      ['老产品', [], null],
      ['Zed!', [], null],
    ])
  })

  it('counts a paused or baselining product as followed, says which, and an archived one as not', async () => {
    const a = addTrack({ name: '赛道A' })
    const c = addTrack({ name: '赛道C' })
    const b = addTrack({ name: '赛道B', status: 'picking' })
    addProduct('paused', '暂停的', 'paused', a.id)
    addProduct('baselining', '建档中的', 'baselining', c.id)
    addProduct('archived-row', '归档的', 'archived', a.id)
    // A candidate row of its own whose twin, the one 开始跟踪 would link, is paused in two tracks.
    addAlike('kimi-paused', 'Kimi 助手', '月之暗面', 'paused', a.id)
    repo.linkProduct(c.id, 'kimi-paused')
    addAlike('kimi-copy', 'Kimi助手!', '月之暗面', 'candidate')
    for (const id of ['paused', 'baselining', 'archived-row', 'kimi-copy']) addCandidate(b.id, id)
    expect((await candidatesOf(b.id)).map(f => [f.product.name, f.trackedIn, f.trackedStatus])).toEqual([
      ['暂停的', ['赛道A'], 'paused'],
      ['建档中的', ['赛道C'], 'baselining'],
      ['归档的', [], null],
      ['Kimi助手!', ['赛道A', '赛道C'], 'paused'],
    ])
  })
})

describe('a recommendation that could not run', () => {
  it('says why its batch is empty: the run\'s status and error', async () => {
    await rt.stop()
    host.cleanup()
    host = apiHost({ config: dataDir => Config({ dataDir, dailyBudgetYuan: 0 }) }) // nothing may be spent today
    rt = host.create()
    rt.start()
    repo = rt.repo
    const { trackId, batchId } = ok(await host.call('POST', 'tracks', { name: 'AI 编程助手', brief: '', extraDimensions: [] })).json<ApiResponse<'POST tracks'>>()
    const view = ok(await host.call('GET', `tracks/${trackId}/candidates`)).json<ApiResponse<'GET tracks/:id/candidates'>>()
    expect(view).toEqual({ batchId, running: false, status: 'skipped', error: '今日总预算已用完', elapsedSec: 0, candidates: [] })
    expect(host.driver.runs).toEqual([])
  })

  it('has no status before the track ever had one', async () => {
    const track = addTrack({ status: 'picking' })
    expect(ok(await host.call('GET', `tracks/${track.id}/candidates`)).json()).toEqual({ batchId: null, running: false, status: null, error: null, elapsedSec: 0, candidates: [] })
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

  it('leaves what the batch finds after the user started tracking waiting to be looked at, not lost', async () => {
    const later = gate()
    const submit = (round: Parameters<Play>[0], name: string, tier: 'strong' | 'consider') => round.call('outpost_submit_candidate', {
      name, company: `${name} Inc`, region: 'overseas', form: 'IDE', oneLiner: `${name} 是 AI 编辑器`, tier, reason: '热度高',
      articles: [{ url: `https://example.com/${name}`, title: `${name} 发布`, publishedAt: '2026-11-20' }],
    })
    host.driver.script[RECOMMEND] = async round => {
      await submit(round, 'Cursor', 'strong')
      await submit(round, 'Zed', 'consider')
      await later.promise
      await submit(round, 'Windsurf', 'strong')
      await round.done('推荐完了')
      return completed()
    }
    const { trackId, batchId } = ok(await host.call('POST', 'tracks', { name: '编程 Agent', brief: '', extraDimensions: [] })).json<ApiResponse<'POST tracks'>>()
    await vi.waitFor(() => { expect(repo.listCandidates(trackId)).toHaveLength(2) })
    const waiting = async () => ok(await host.call('GET', 'state')).json<ApiResponse<'GET state'>>().tracks.find(t => t.track.id === trackId)!.candidatesToReview
    expect(repo.getRun(batchId)!.status).toBe('running')
    expect(await waiting()).toBe(2)

    // The user picks Cursor from the two found so far, while the round goes on: Zed was seen and passed over.
    const cursor = repo.listCandidates(trackId).find(c => repo.getProduct(c.productId)!.name === 'Cursor')!
    ok(await host.call('POST', `tracks/${trackId}/start`, { candidateIds: [cursor.id] }))
    expect(await waiting()).toBe(0)

    // What it finds afterwards is new to the user: it waits under 「候选推荐」.
    later.open()
    await vi.waitFor(() => { expect(repo.getRun(batchId)!.status).toBe('done') })
    expect(repo.listCandidates(trackId)).toHaveLength(3)
    expect(await waiting()).toBe(1)
    expect(repo.listCandidates(trackId).filter(c => c.selected).map(c => repo.getProduct(c.productId)!.name)).toEqual(['Cursor', 'Windsurf'])

    // Starting again from that batch has everything in it seen.
    const windsurf = repo.listCandidates(trackId).find(c => repo.getProduct(c.productId)!.name === 'Windsurf')!
    ok(await host.call('POST', `tracks/${trackId}/start`, { candidateIds: [windsurf.id] }))
    expect(await waiting()).toBe(0)
  })

  it('fills in at once the dimensions a tracked product lacks when it joins a track that has them', async () => {
    const other = addTrack({ name: '老赛道' })
    addProduct('p0', 'Cursor', 'tracking', other.id)
    for (const dim of DEFAULT_DIMENSIONS) card('p0', dim.key, 1, [])
    addRun('baseline', { status: 'done', startedAt: '2026-11-24T08:00:00.000Z', endedAt: '2026-11-24T08:20:00.000Z' }, '2026-11-24', { productId: 'p0' })
    host.driver.script[RECOMMEND] = recommends([['Cursor', 'strong']])
    const { trackId, batchId } = ok(await host.call('POST', 'tracks', { name: '编程 Agent', brief: '', extraDimensions: ['定价模式'] })).json<ApiResponse<'POST tracks'>>()
    await vi.waitFor(() => { expect(repo.getRun(batchId)!.status).toBe('done') })

    ok(await host.call('POST', `tracks/${trackId}/start`, { candidateIds: repo.listCandidates(trackId).map(c => c.id) }))
    await vi.waitFor(() => { expect(host.driver.runs.map(r => r.title)).toContain('前哨 · Cursor 建档') })
    const prompt = host.driver.runs.find(r => r.title === '前哨 · Cursor 建档')!.prompt
    expect(prompt).toContain(`- ${slugDimension('定价模式')}：定价模式`) // what the new track adds
    expect(prompt).not.toContain('- audience：目标人群') // not what it has
    expect(repo.getProduct('p0')!.status).toBe('tracking') // stays tracked meanwhile
  })

  it('starting a candidate whose twin is tracked elsewhere links the tracked product', async () => {
    const baseline = vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    const topUpNow = vi.spyOn(rt.scheduler, 'topUpNow').mockResolvedValue()
    const a = addTrack({ name: '赛道A' })
    addAlike('tracked', '千问Go!', '阿里巴巴', 'tracking', a.id)
    for (const dim of DEFAULT_DIMENSIONS) card('tracked', dim.key, 1, [])
    const b = addTrack({ name: '赛道B', status: 'picking', dimensions: [...DEFAULT_DIMENSIONS, { key: 'pricing-model', label: '定价模式' }] })
    addAlike('copy', '千问Go', '阿里巴巴', 'candidate')
    const candidate = addCandidate(b.id, 'copy')

    ok(await host.call('POST', `tracks/${b.id}/start`, { candidateIds: [candidate.id] }))

    expect(repo.productsOfTrack(b.id).map(p => [p.id, p.name])).toEqual([['tracked', '千问Go!']]) // not the row the candidate points at
    expect(repo.getProduct('copy')).toMatchObject({ status: 'candidate', name: '千问Go' }) // left alone
    expect(baseline).toHaveBeenCalledTimes(1)
    expect(baseline).toHaveBeenCalledWith([]) // no new baseline
    expect(topUpNow).toHaveBeenCalledTimes(1)
    expect(topUpNow).toHaveBeenCalledWith(['tracked']) // only the dimension B adds
    expect(repo.getProduct('tracked')!.status).toBe('tracking')
    expect(repo.listCandidates(b.id).map(c => [c.id, c.selected])).toEqual([[candidate.id, true]]) // the choice is still recorded as made
  })

  it('joins a twin in 建档中 or 暂停 as it is: the one being baselined gets the new dimensions, the paused one is left alone', async () => {
    const baseline = vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    const topUpNow = vi.spyOn(rt.scheduler, 'topUpNow').mockResolvedValue()
    const a = addTrack({ name: '赛道A' })
    addAlike('running', '阶跃 Amoo', '阶跃星辰', 'baselining', a.id)
    addAlike('stopped', 'Muse', 'Meta', 'paused', a.id)
    const b = addTrack({ name: '赛道B', status: 'picking', dimensions: [...DEFAULT_DIMENSIONS, { key: 'pricing-model', label: '定价模式' }] })
    const chosen = [['阶跃Amoo', '阶跃星辰'], ['Muse!', 'META']].map(([name, company], i) => {
      addAlike(`copy-${i}`, name!, company!, 'candidate')
      return addCandidate(b.id, `copy-${i}`).id
    })

    ok(await host.call('POST', `tracks/${b.id}/start`, { candidateIds: chosen }))

    expect(repo.productsOfTrack(b.id).map(p => p.id)).toEqual(['running', 'stopped'])
    expect(baseline).toHaveBeenCalledWith([])
    expect(topUpNow).toHaveBeenCalledTimes(1)
    expect(topUpNow).toHaveBeenCalledWith(['running'])
    expect(['running', 'stopped'].map(id => repo.getProduct(id)!.status)).toEqual(['baselining', 'paused'])
  })

  it('takes only the first of two ticked candidates that are spellings of one product, and baselines it once', async () => {
    const baseline = vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    vi.spyOn(rt.scheduler, 'topUpNow').mockResolvedValue()
    addAlike('first', '千问Go!', '阿里巴巴', 'candidate')
    addAlike('second', '千问Go', '阿里巴巴', 'candidate')
    addAlike('other', '千问Plus', '阿里巴巴', 'candidate') // another product, picked in the same go
    const b = addTrack({ name: '赛道B', status: 'picking' })
    const chosen = ['first', 'second', 'other'].map(id => addCandidate(b.id, id).id)

    ok(await host.call('POST', `tracks/${b.id}/start`, { candidateIds: chosen }))

    expect(baseline).toHaveBeenCalledTimes(1)
    expect(baseline).toHaveBeenCalledWith(['first', 'other']) // one id for the two spellings, in the order ticked
    expect(repo.productsOfTrack(b.id).map(p => p.id)).toEqual(['first', 'other'])
    expect(repo.getProduct('second')).toMatchObject({ status: 'candidate', name: '千问Go' }) // left a candidate, not linked
  })

  it('links a tracked twin once and tops it up once when two ticked candidates are both its spellings', async () => {
    vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    const topUpNow = vi.spyOn(rt.scheduler, 'topUpNow').mockResolvedValue()
    const a = addTrack({ name: '赛道A' })
    addAlike('tracked', '千问Go!', '阿里巴巴', 'tracking', a.id)
    for (const dim of DEFAULT_DIMENSIONS) card('tracked', dim.key, 1, [])
    addAlike('copy-1', '千问Go', '阿里巴巴', 'candidate')
    addAlike('copy-2', '千问 Go', '阿里巴巴', 'candidate')
    const b = addTrack({ name: '赛道B', status: 'picking', dimensions: [...DEFAULT_DIMENSIONS, { key: 'pricing-model', label: '定价模式' }] })
    const chosen = ['copy-1', 'copy-2'].map(id => addCandidate(b.id, id).id)

    ok(await host.call('POST', `tracks/${b.id}/start`, { candidateIds: chosen }))

    expect(repo.productsOfTrack(b.id).map(p => p.id)).toEqual(['tracked'])
    expect(topUpNow).toHaveBeenCalledTimes(1)
    expect(topUpNow).toHaveBeenCalledWith(['tracked'])
  })

  it('does not take two products whose names are only different symbols for one', async () => {
    const baseline = vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    addAlike('star', '★', 'X', 'candidate')
    addAlike('hollow', '☆', 'X', 'candidate')
    const b = addTrack({ name: '赛道B', status: 'picking' })
    ok(await host.call('POST', `tracks/${b.id}/start`, { candidateIds: ['star', 'hollow'].map(id => addCandidate(b.id, id).id) }))
    expect(baseline).toHaveBeenCalledWith(['star', 'hollow'])
  })

  it('keeps the row a candidate points at when that row is tracked itself, and baselines a candidate whose twins are all candidates', async () => {
    const baseline = vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    vi.spyOn(rt.scheduler, 'topUpNow').mockResolvedValue()
    const a = addTrack({ name: '赛道A' })
    addAlike('own', 'Zed', 'Zed Inc', 'tracking', a.id)
    addAlike('own-twin', 'Zed!', 'Zed Inc', 'tracking')
    addAlike('new', 'Windsurf', 'Codeium', 'candidate')
    addAlike('new-twin', 'Wind surf', 'Codeium', 'candidate')
    const b = addTrack({ name: '赛道B', status: 'picking' })
    const chosen = ['own', 'new'].map(id => addCandidate(b.id, id).id)

    ok(await host.call('POST', `tracks/${b.id}/start`, { candidateIds: chosen }))

    expect(repo.productsOfTrack(b.id).map(p => p.id)).toEqual(['own', 'new'])
    expect(baseline).toHaveBeenCalledWith(['new'])
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

describe('POST tracks/:id/add-product', () => {
  const PRICING: Dimension = { key: 'pricing-model', label: '定价模式' }

  it('adding a name that is followed in another track links it without a run', async () => {
    const baseline = vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    const topUpNow = vi.spyOn(rt.scheduler, 'topUpNow').mockResolvedValue()
    const a = addTrack({ name: '赛道A' })
    addAlike('tracked', '千问Go!', '阿里巴巴', 'tracking', a.id)
    for (const dim of DEFAULT_DIMENSIONS) card('tracked', dim.key, 1, [])
    addAlike('copy', '千问Go', '阿里巴巴', 'candidate') // a candidate row of the same product does not count
    const b = addTrack({ name: '赛道B', dimensions: [...DEFAULT_DIMENSIONS, PRICING] })

    const reply = ok(await host.call('POST', `tracks/${b.id}/add-product`, { name: '千问go' }))

    expect(reply.json()).toEqual({ linked: 'tracked', status: 'tracking' })
    expect(repo.productsOfTrack(b.id).map(p => p.id)).toEqual(['tracked'])
    expect(repo.productsOfTrack(a.id).map(p => p.id)).toEqual(['tracked']) // still in its own track
    await flush()
    expect(repo.listRuns('')).toEqual([]) // nothing confirmed, nothing spent
    expect(host.driver.runs).toEqual([])
    expect(topUpNow).toHaveBeenCalledTimes(1)
    expect(topUpNow).toHaveBeenCalledWith(['tracked']) // for the one dimension B adds
    expect(baseline.mock.calls.flat(2)).toEqual([]) // no baseline
    expect(repo.getProduct('tracked')!.status).toBe('tracking')
  })

  it('adding the name of a paused product links it as it is, neither resumed nor topped up', async () => {
    const baseline = vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    const topUpNow = vi.spyOn(rt.scheduler, 'topUpNow').mockResolvedValue()
    const a = addTrack({ name: '赛道A' })
    addAlike('stopped', 'Muse', 'Meta', 'paused', a.id)
    const b = addTrack({ name: '赛道B', dimensions: [...DEFAULT_DIMENSIONS, PRICING] })

    expect(ok(await host.call('POST', `tracks/${b.id}/add-product`, { name: 'muse', officialUrl: 'https://muse.meta.com/' })).json())
      .toEqual({ linked: 'stopped', status: 'paused' })

    await flush()
    expect(repo.productsOfTrack(b.id).map(p => p.id)).toEqual(['stopped'])
    expect(repo.getProduct('stopped')!.status).toBe('paused')
    expect(topUpNow).not.toHaveBeenCalled()
    expect(baseline.mock.calls.flat(2)).toEqual([])
    expect(repo.listRuns('')).toEqual([])
  })

  it('adding an unknown name starts an identify run', async () => {
    const held = gate()
    host.driver.script[IDENTIFY] = async round => {
      await held.promise
      if (!round.text.includes('Gemini Agent')) { await round.done('没有找到这个产品'); return completed() }
      await round.call('outpost_submit_candidate', {
        name: 'Gemini Agent', company: 'Google', region: 'overseas', form: '网页', oneLiner: 'Gemini 里能替你办事的 Agent', tier: 'strong', reason: '11 月向 Ultra 用户开放',
        officialUrl: 'https://gemini.google/agent/', articles: [{ url: 'https://blog.google/gemini-agent', title: 'Gemini Agent 上线', publishedAt: '2026-11-20' }],
      })
      await round.done('已确认：Gemini Agent（Google）')
      return completed()
    }
    host.driver.script[BASELINE] = holds(new Promise(() => {})) // its baseline starts and stays running
    const t = addTrack({ name: '个人 Agent', brief: '能替人办事的 Agent' })
    // The same name at two companies, both followed: the name alone cannot say which, so it is confirmed too.
    const other = addTrack({ name: '别的赛道' })
    addAlike('one', 'Nova', 'Amazon', 'tracking', other.id)
    addAlike('two', 'Nova', '某创业公司', 'tracking', other.id)

    const { runId } = ok(await host.call('POST', `tracks/${t.id}/add-product`, { name: ' Gemini Agent ', officialUrl: 'https://gemini.google/agent/' })).json<{ runId: Id }>()

    expect(repo.getRun(runId)).toMatchObject({ kind: 'identify', trackId: t.id, productId: null, subject: 'Gemini Agent' })
    expect(repo.productsOfTrack(t.id)).toEqual([])
    await vi.waitFor(() => { expect(host.driver.runs.map(r => r.title)).toEqual(['前哨 · 确认产品 Gemini Agent']) })
    expect(host.driver.runs[0]!.prompt).toContain('https://gemini.google/agent/')
    // The run log names it by what was typed while the product is not known yet.
    const listed = ok(await host.call('GET', 'runs')).json<ApiResponse<'GET runs'>>().runs.find(r => r.id === runId)!
    expect(listed).toMatchObject({ kind: 'identify', status: 'running', subject: 'Gemini Agent', productName: null })

    held.open()
    await vi.waitFor(() => { expect(host.driver.runs.map(r => r.title)).toContain('前哨 · Gemini Agent 建档') })
    const joined = repo.productsOfTrack(t.id)
    expect(joined.map(p => [p.name, p.company, p.status])).toEqual([['Gemini Agent', 'Google', 'baselining']])
    expect(repo.getRun(runId)).toMatchObject({ status: 'done', error: null, productId: joined[0]!.id })
    expect(ok(await host.call('GET', 'runs')).json<ApiResponse<'GET runs'>>().runs.find(r => r.id === runId)).toMatchObject({ productName: 'Gemini Agent' })
    // It is not a batch to pick from.
    expect(ok(await host.call('GET', `tracks/${t.id}/candidates`)).json<ApiResponse<'GET tracks/:id/candidates'>>()).toMatchObject({ batchId: null, candidates: [] })

    ok(await host.call('POST', `tracks/${t.id}/add-product`, { name: 'nova' }))
    expect(repo.listRuns('').filter(r => r.kind === 'identify').map(r => r.subject)).toEqual(['nova', 'Gemini Agent'])
  })

  it('answers a second click on the same name with the confirmation already running, and starts nothing new', async () => {
    const held = gate()
    host.driver.script[IDENTIFY] = async round => { await held.promise; await round.done('没有找到'); return completed() }
    const t = addTrack({ name: '个人 Agent' })
    const other = addTrack({ name: '别的赛道' })
    const add = async (trackId: Id, name: string) => ok(await host.call('POST', `tracks/${trackId}/add-product`, { name })).json<{ runId: Id }>().runId

    const first = await add(t.id, 'Gemini Agent')
    expect(await add(t.id, ' gemini  agent! ')).toBe(first) // the same name, as `identityKey` reads names
    await vi.waitFor(() => { expect(host.driver.runs).toHaveLength(1) })
    expect(await add(t.id, 'Gemini Agent')).toBe(first) // running now, still the same
    // Another name, or the same name for another track, is another confirmation.
    const another = await add(t.id, 'Gemini Agent Pro')
    const elsewhere = await add(other.id, 'Gemini Agent')
    expect(new Set([first, another, elsewhere]).size).toBe(3)
    expect(repo.listRuns('').filter(r => r.kind === 'identify')).toHaveLength(3)

    held.open()
    await vi.waitFor(() => { expect(repo.getRun(first)!.status).toBe('done') })
    expect(await add(t.id, 'Gemini Agent')).not.toBe(first) // over: asking again confirms again
  })

  it('says a product is already in the track and changes nothing', async () => {
    const baseline = vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    const topUpNow = vi.spyOn(rt.scheduler, 'topUpNow').mockResolvedValue()
    const t = addTrack({ name: '赛道B', dimensions: [...DEFAULT_DIMENSIONS, PRICING] })
    addAlike('here', '千问Go!', '阿里巴巴', 'tracking', t.id)
    const paused = addAlike('paused-here', 'Muse', 'Meta', 'paused', t.id)

    expect(ok(await host.call('POST', `tracks/${t.id}/add-product`, { name: '千问 go' })).json()).toEqual({ linked: 'here', status: 'tracking', already: true })
    expect(ok(await host.call('POST', `tracks/${t.id}/add-product`, { name: 'MUSE' })).json()).toEqual({ linked: paused.id, status: 'paused', already: true })

    await flush()
    expect(repo.productsOfTrack(t.id).map(p => p.id)).toEqual(['here', 'paused-here'])
    expect(topUpNow).not.toHaveBeenCalled()
    expect(baseline).not.toHaveBeenCalled()
    expect(repo.listRuns('')).toEqual([])
    expect(repo.getProduct('paused-here')!.status).toBe('paused')
  })

  it('refuses to add to an archived track', async () => {
    const t = addTrack({ name: '旧赛道', status: 'archived' })
    addProduct('p1', 'Cursor', 'tracking')
    const reply = await host.call('POST', `tracks/${t.id}/add-product`, { name: 'Cursor' })
    expect(reply.status).toBe(409)
    expect(reply.json()).toEqual({ error: '这个赛道已归档' })
    expect((await host.call('POST', `tracks/${t.id}/add-product`, { name: 'Gemini Agent' })).status).toBe(409)
    await flush()
    expect(repo.productsOfTrack(t.id)).toEqual([])
    expect(repo.listRuns('')).toEqual([])
  })

  it('rejects an empty name and a non-http official url', async () => {
    vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    vi.spyOn(rt.scheduler, 'topUpNow').mockResolvedValue()
    const t = addTrack()
    addProduct('p1', 'Cursor', 'tracking')
    for (const body of [{ name: '' }, { name: '   ' }, {}, { name: 'x'.repeat(31) }, { name: 'Cursor', officialUrl: 'ftp://cursor.com/' },
      { name: 'Cursor', officialUrl: 'cursor.com' }, { name: 'Cursor', officialUrl: 'javascript:alert(1)' }, { name: 'Cursor', officialUrl: 42 }]) {
      expect((await host.call('POST', `tracks/${t.id}/add-product`, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await host.call('POST', 'tracks/nope/add-product', { name: 'Cursor' })).status).toBe(404)
    await flush()
    expect(repo.productsOfTrack(t.id)).toEqual([])
    expect(repo.listRuns('')).toEqual([])
    // A blank official site is one not given.
    expect(ok(await host.call('POST', `tracks/${t.id}/add-product`, { name: 'Cursor', officialUrl: '  ' })).json()).toEqual({ linked: 'p1', status: 'tracking' })
  })
})

describe('moving products between tracks', () => {
  const PRICING: Dimension = { key: 'pricing-model', label: '定价模式' }
  const PRIVACY: Dimension = { key: 'privacy', label: '隐私' }
  /** A tracked product with a card for every dimension of `dims`. */
  const followed = (id: Id, name: string, trackId: Id, dims: Dimension[] = DEFAULT_DIMENSIONS, status: ProductStatus = 'tracking') => {
    addProduct(id, name, status, trackId)
    if (status === 'tracking') for (const dim of dims) card(id, dim.key, 1, [])
  }
  const inTracks = (productId: Id) => repo.listTracks().filter(t => repo.productsOfTrack(t.id).some(p => p.id === productId)).map(t => t.name)
  /** The kinds of the sessions started so far, in order: `daily`, `baseline`, `verify`. */
  const sessions = () => host.driver.runs.map(r => /^outpost-(\w+)-/.exec(r.sessionId)?.[1])
  let baseline: ReturnType<typeof vi.spyOn>
  let topUpNow: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    baseline = vi.spyOn(rt.scheduler, 'baseline').mockResolvedValue()
    topUpNow = vi.spyOn(rt.scheduler, 'topUpNow').mockResolvedValue()
  })
  const untouched = async () => {
    await flush()
    expect(topUpNow).not.toHaveBeenCalled()
    expect(baseline.mock.calls.flat(2)).toEqual([])
    expect(repo.listRuns('')).toEqual([])
  }

  it('link adds the track and tops up only the missing cards', async () => {
    const a = addTrack({ name: '赛道A' })
    followed('p1', 'Cursor', a.id)
    card('p1', PRIVACY.key, 1, []) // a card it has already, for a dimension B will ask for too
    const b = addTrack({ name: '赛道B', dimensions: [...DEFAULT_DIMENSIONS, PRICING, PRIVACY] })

    const reply = ok(await host.call('POST', 'products/p1/link', { trackId: b.id }))

    expect(reply.json()).toEqual({ toppedUp: 1 }) // 定价模式 only: 隐私 has its card, the six defaults are the same
    expect(inTracks('p1')).toEqual(['赛道A', '赛道B'])
    expect(repo.dimensionsOfProduct('p1').map(d => d.key)).toContain(PRICING.key)
    await flush()
    expect(topUpNow).toHaveBeenCalledTimes(1)
    expect(topUpNow).toHaveBeenCalledWith(['p1'])
    expect(baseline.mock.calls.flat(2)).toEqual([]) // a followed product is not baselined again
    expect(repo.getProduct('p1')!.status).toBe('tracking')
    expect(repo.latestCards('p1')).toHaveLength(DEFAULT_DIMENSIONS.length + 1) // its dossier is as it was
  })

  it('link into a track that adds nothing joins it and fills in nothing', async () => {
    const a = addTrack({ name: '赛道A' })
    followed('p1', 'Cursor', a.id)
    const b = addTrack({ name: '赛道B' })
    expect(ok(await host.call('POST', 'products/p1/link', { trackId: b.id })).json()).toEqual({ toppedUp: 0 })
    expect(inTracks('p1')).toEqual(['赛道A', '赛道B'])
    await untouched()
  })

  it('move swaps tracks in one step and reports the cards to fill', async () => {
    const a = addTrack({ name: '赛道A', dimensions: [...DEFAULT_DIMENSIONS, { key: 'only-a', label: '只有 A' }] })
    followed('p1', 'Cursor', a.id, [...DEFAULT_DIMENSIONS, { key: 'only-a', label: '只有 A' }])
    addProduct('p2', 'Windsurf', 'tracking', a.id)
    const b = addTrack({ name: '赛道B', dimensions: [...DEFAULT_DIMENSIONS, PRICING, PRIVACY] })
    const history = repo.cardHistory('p1', 'positioning')

    const reply = ok(await host.call('POST', 'products/p1/move', { from: a.id, to: b.id }))

    expect(reply.json()).toEqual({ toppedUp: 2 }) // 定价模式 and 隐私
    expect(inTracks('p1')).toEqual(['赛道B'])
    expect(repo.productsOfTrack(a.id).map(p => p.id)).toEqual(['p2']) // the other product stays where it was
    // The dossier and its history are kept, the card of the dimension only A had too (it just no longer shows).
    expect(repo.latestCards('p1').map(c => c.dimension).sort()).toEqual([...DEFAULT_DIMENSIONS.map(d => d.key), 'only-a'].sort())
    expect(repo.cardHistory('p1', 'positioning')).toEqual(history)
    expect(repo.dimensionsOfProduct('p1').map(d => d.key)).toEqual([...DEFAULT_DIMENSIONS, PRICING, PRIVACY].map(d => d.key))
    await flush()
    expect(topUpNow).toHaveBeenCalledTimes(1)
    expect(topUpNow).toHaveBeenCalledWith(['p1'])
    expect(baseline.mock.calls.flat(2)).toEqual([])
    expect(repo.getProduct('p1')!.status).toBe('tracking')
  })

  it('starts the top-up only once the product has left its old track, so it asks for what the new track needs', async () => {
    const a = addTrack({ name: '赛道A', dimensions: [...DEFAULT_DIMENSIONS, { key: 'only-a', label: '只有 A' }] })
    followed('p1', 'Cursor', a.id) // no card for only-a
    const b = addTrack({ name: '赛道B', dimensions: [...DEFAULT_DIMENSIONS, PRICING] })
    const seen: string[][] = []
    topUpNow.mockImplementation(async () => { seen.push(repo.dimensionsOfProduct('p1').map(d => d.key)) })

    expect(ok(await host.call('POST', 'products/p1/move', { from: a.id, to: b.id })).json()).toEqual({ toppedUp: 1 })

    await flush()
    expect(seen).toEqual([[...DEFAULT_DIMENSIONS, PRICING].map(d => d.key)]) // B's dimensions only: A's is not a card to fill in
  })

  it('a move that fails half-way leaves the product in its old track', async () => {
    const a = addTrack({ name: '赛道A' })
    followed('p1', 'Cursor', a.id)
    const b = addTrack({ name: '赛道B', dimensions: [...DEFAULT_DIMENSIONS, PRICING] })
    vi.spyOn(repo, 'unlinkProduct').mockImplementation(() => { throw new Error('disk full') })

    expect((await host.call('POST', 'products/p1/move', { from: a.id, to: b.id })).status).toBe(500)

    expect(inTracks('p1')).toEqual(['赛道A']) // not in B as well: the add was rolled back with the rest
    await untouched()
  })

  it('unlink takes the product out of one track and keeps its dossier', async () => {
    const a = addTrack({ name: '赛道A', dimensions: [...DEFAULT_DIMENSIONS, { key: 'only-a', label: '只有 A' }] })
    const b = addTrack({ name: '赛道B' })
    followed('p1', 'Cursor', a.id, [...DEFAULT_DIMENSIONS, { key: 'only-a', label: '只有 A' }])
    repo.linkProduct(b.id, 'p1')
    addProduct('p2', 'Windsurf', 'tracking', a.id)

    expect(ok(await host.call('POST', 'products/p1/unlink', { trackId: a.id })).json()).toEqual({ ok: true })

    expect(inTracks('p1')).toEqual(['赛道B'])
    expect(repo.productsOfTrack(a.id).map(p => p.id)).toEqual(['p2'])
    expect(repo.latestCards('p1').map(c => c.dimension)).toContain('only-a') // kept, no longer shown
    expect(repo.getProduct('p1')!.status).toBe('tracking')
    await untouched()
  })

  it('unlink refuses the last track', async () => {
    const a = addTrack({ name: '赛道A' })
    followed('p1', 'Cursor', a.id)
    const reply = await host.call('POST', 'products/p1/unlink', { trackId: a.id })
    expect(reply.status).toBe(409)
    expect(reply.json()).toEqual({ error: '这是它唯一的赛道。不想跟了就用「暂停跟踪」。' })
    expect(inTracks('p1')).toEqual(['赛道A'])

    // An archived track is no track to keep a product in: nothing runs there.
    const old = addTrack({ name: '旧赛道', status: 'archived' })
    repo.linkProduct(old.id, 'p1')
    const again = await host.call('POST', 'products/p1/unlink', { trackId: a.id })
    expect(again.status).toBe(409)
    expect(again.json()).toEqual({ error: '这是它唯一的赛道。不想跟了就用「暂停跟踪」。' })
    expect(inTracks('p1')).toEqual(['赛道A', '旧赛道'])
    // Leaving the archived one is fine: it stays in the track that runs.
    ok(await host.call('POST', 'products/p1/unlink', { trackId: old.id }))
    expect(inTracks('p1')).toEqual(['赛道A'])
    await untouched()
  })

  it('refuses an archived, unknown or already-joined target, and a track the product is not in', async () => {
    const a = addTrack({ name: '赛道A' })
    const b = addTrack({ name: '赛道B' })
    const old = addTrack({ name: '旧赛道', status: 'archived' })
    followed('p1', 'Cursor', a.id)
    repo.linkProduct(b.id, 'p1')
    const refused = async (route: string, body: object, error: string) => {
      const reply = await host.call('POST', route, body)
      expect(reply.status, `${route} ${JSON.stringify(body)}`).toBe(409)
      expect(reply.json()).toEqual({ error })
    }
    for (const [route, body] of [['link', (to: Id) => ({ trackId: to })], ['move', (to: Id) => ({ from: a.id, to })]] as const) {
      await refused(`products/p1/${route}`, body(old.id), '这个赛道已归档')
      await refused(`products/p1/${route}`, body('nope'), '找不到这个赛道')
      await refused(`products/p1/${route}`, body(b.id), '它已经在这个赛道里了') // in it already
    }
    await refused('products/p1/move', { from: a.id, to: a.id }, '它已经在这个赛道里了')
    const c = addTrack({ name: '赛道C' })
    await refused('products/p1/move', { from: c.id, to: old.id }, '这个赛道已归档')
    await refused('products/p1/move', { from: c.id, to: addTrack({ name: '赛道D' }).id }, '它不在这个赛道里') // not where it is
    await refused('products/p1/unlink', { trackId: c.id }, '它不在这个赛道里')
    await refused('products/p1/unlink', { trackId: 'nope' }, '它不在这个赛道里')
    // A product Outpost does not follow is not moved around either.
    addProduct('c1', '豆包', 'candidate')
    await refused('products/c1/link', { trackId: c.id }, '这个产品没有在跟踪')
    await refused('products/c1/move', { from: a.id, to: c.id }, '这个产品没有在跟踪')
    expect(inTracks('p1')).toEqual(['赛道A', '赛道B'])
    expect(inTracks('c1')).toEqual([])
    await untouched()
  })

  it('answers 404 for an unknown product and 400 for a body that does not say which tracks', async () => {
    const a = addTrack({ name: '赛道A' })
    const b = addTrack({ name: '赛道B' })
    followed('p1', 'Cursor', a.id)
    for (const route of ['link', 'unlink', 'move']) {
      const reply = await host.call('POST', `products/nope/${route}`, { trackId: a.id, from: a.id, to: b.id })
      expect(reply.status, route).toBe(404)
      expect(reply.json()).toEqual({ error: '找不到这个产品' })
    }
    for (const [route, body] of [['link', {}], ['link', { trackId: '' }], ['link', { trackId: 3 }], ['unlink', {}], ['move', { to: b.id }], ['move', { from: a.id }], ['move', { from: '', to: b.id }]] as const) {
      expect((await host.call('POST', `products/p1/${route}`, body)).status, `${route} ${JSON.stringify(body)}`).toBe(400)
    }
    expect(inTracks('p1')).toEqual(['赛道A'])
    // Changes are JSON, as everywhere (415 comes before anything else).
    for (const route of ['link', 'unlink', 'move']) {
      expect((await host.call('POST', `products/p1/${route}`, JSON.stringify({ trackId: b.id, from: a.id, to: b.id }), { 'content-type': 'text/plain' })).status, route).toBe(415)
    }
    expect(inTracks('p1')).toEqual(['赛道A'])
    await untouched()
  })

  it('move of a product whose daily run is in flight waits for it before topping up', async () => {
    topUpNow.mockRestore()
    const toppedUp = vi.spyOn(rt.scheduler, 'topUpNow') // the real one, watched
    const held = gate()
    host.driver.script[DAILY] = holds(held.promise)
    host.driver.script[BASELINE] = baselines([PRICING.key])
    host.driver.script['outpost-verify-'] = checksAll
    const a = addTrack({ name: '赛道A' })
    followed('p1', 'Cursor', a.id)
    const b = addTrack({ name: '赛道B', dimensions: [...DEFAULT_DIMENSIONS, PRICING] })
    const { runId } = ok(await host.call('POST', 'products/p1/update-now')).json<ApiResponse<'POST products/:id/update-now'>>()
    await vi.waitFor(() => { expect(sessions()).toEqual(['daily']) })

    expect(ok(await host.call('POST', 'products/p1/move', { from: a.id, to: b.id })).json()).toEqual({ toppedUp: 1 })

    expect(toppedUp).toHaveBeenCalledWith(['p1'])
    await flush()
    expect(sessions()).toEqual(['daily']) // the cards wait: no second session beside the daily run
    expect(repo.getRun(runId)!.status).toBe('running') // and the daily run is not interrupted
    held.open()
    await vi.waitFor(() => { expect(repo.getRun(runId)!.status).toBe('done') })
    await vi.waitFor(() => { expect(repo.latestCards('p1').map(c => c.dimension)).toContain(PRICING.key) })
    expect(sessions()).toEqual(['daily', 'baseline', 'verify']) // then the cards, after it
    expect(askedFor(host.driver.runs[1]!.prompt, [...DEFAULT_DIMENSIONS, PRICING].map(d => d.key))).toEqual([PRICING.key]) // only what B adds
    expect(repo.getRun(runId)).toMatchObject({ status: 'done', error: null })
    expect(inTracks('p1')).toEqual(['赛道B'])
  })

  it('a paused product stays paused after a move, and is not topped up', async () => {
    const a = addTrack({ name: '赛道A' })
    followed('p1', 'Muse', a.id, DEFAULT_DIMENSIONS, 'paused')
    const b = addTrack({ name: '赛道B', dimensions: [...DEFAULT_DIMENSIONS, PRICING] })
    const c = addTrack({ name: '赛道C', dimensions: [...DEFAULT_DIMENSIONS, PRIVACY] })

    expect(ok(await host.call('POST', 'products/p1/move', { from: a.id, to: b.id })).json()).toEqual({ toppedUp: 0 })
    expect(ok(await host.call('POST', 'products/p1/link', { trackId: c.id })).json()).toEqual({ toppedUp: 0 })

    expect(inTracks('p1')).toEqual(['赛道B', '赛道C'])
    expect(repo.getProduct('p1')!.status).toBe('paused')
    await untouched()
  })

  it('a product in 建档中 keeps its baseline and gets the new cards after it', async () => {
    const a = addTrack({ name: '赛道A' })
    addProduct('p1', 'Cursor', 'baselining', a.id)
    const b = addTrack({ name: '赛道B', dimensions: [...DEFAULT_DIMENSIONS, PRICING] })
    expect(ok(await host.call('POST', 'products/p1/move', { from: a.id, to: b.id })).json()).toEqual({ toppedUp: 1 })
    await flush()
    expect(repo.getProduct('p1')!.status).toBe('baselining')
    expect(topUpNow).toHaveBeenCalledWith(['p1']) // it joins the baseline in flight, then asks for what is still missing
    expect(baseline.mock.calls.flat(2)).toEqual([])
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

  it('retries a failed check as a check alone, after which the daily run it failed counts as done', async () => {
    const track = addTrack({ dimensions: [{ key: 'positioning', label: '定位' }] })
    addProduct('p1', 'Cursor', 'tracking', track.id)
    card('p1', 'positioning', 1, [])
    const daily = addRun('daily', { status: 'failed', error: '核查没有完成：模型返回了无法解析的内容' }, TODAY, { productId: 'p1' })
    const failed = addRun('verify', { status: 'failed', error: '模型返回了无法解析的内容' }, TODAY, { productId: 'p1' })
    const source = repo.addSource({
      url: 'https://cursor.com/changelog/2-0', title: 'Cursor 2.0', publisher: 'Cursor', publishedAt: '2026-11-24', kind: 'official', isOfficial: true,
      quote: 'Background agents are now generally available', syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null,
    })
    const waiting = repo.addFinding({ // what the daily run handed in, still waiting for a check
      productId: 'p1', runId: daily.id, headline: '后台 Agent 正式上线', why: '值得看', importance: 'major', claimKind: 'self', sourceIds: [source.id], status: 'pending',
      statusNote: null, unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: randomUUID(), verifiedOn: null,
    })
    host.driver.script['outpost-verify-'] = checksAll

    const { runId } = ok(await host.call('POST', `runs/${failed.id}/retry`)).json<ApiResponse<'POST runs/:id/retry'>>()

    expect(repo.getRun(runId)).toMatchObject({ kind: 'verify', productId: 'p1', date: TODAY })
    await vi.waitFor(() => { expect(repo.getRun(daily.id)).toMatchObject({ status: 'done', error: null }) })
    expect(host.driver.runs.map(r => r.title)).toEqual(['前哨 · Cursor 核查 2026-11-25']) // no daily session, only the check
    expect(repo.getFinding(waiting.id)).toMatchObject({ status: 'verified', verifiedOn: TODAY })
    await vi.waitFor(() => { expect(repo.getBrief(TODAY)!.findingIds).toEqual([waiting.id]) })
  })

  it('retries a daily update that failed only because its check did not finish as that check alone', async () => {
    const track = addTrack({ dimensions: [{ key: 'positioning', label: '定位' }] })
    addProduct('p1', 'Cursor', 'tracking', track.id)
    card('p1', 'positioning', 1, [])
    const daily = addRun('daily', { status: 'failed', error: '核查没有完成：模型返回了无法解析的内容' }, TODAY, { productId: 'p1' })
    const source = repo.addSource({
      url: 'https://cursor.com/changelog/2-0', title: 'Cursor 2.0', publisher: 'Cursor', publishedAt: '2026-11-24', kind: 'official', isOfficial: true,
      quote: 'Background agents are now generally available', syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null,
    })
    const waiting = repo.addFinding({
      productId: 'p1', runId: daily.id, headline: '后台 Agent 正式上线', why: '值得看', importance: 'major', claimKind: 'self', sourceIds: [source.id], status: 'pending',
      statusNote: null, unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: randomUUID(), verifiedOn: null,
    })
    host.driver.script['outpost-verify-'] = checksAll

    const { runId } = ok(await host.call('POST', `runs/${daily.id}/retry`)).json<ApiResponse<'POST runs/:id/retry'>>()

    expect(repo.getRun(runId)).toMatchObject({ kind: 'verify', productId: 'p1', date: TODAY })
    await vi.waitFor(() => { expect(repo.getRun(daily.id)).toMatchObject({ status: 'done', error: null }) })
    expect(host.driver.runs.map(r => r.title)).toEqual(['前哨 · Cursor 核查 2026-11-25']) // the research is in: no new daily session
    expect(repo.getFinding(waiting.id)).toMatchObject({ status: 'verified', verifiedOn: TODAY })
  })

  it('refuses to retry what was already done again: a later run of the same work, a finished update that day, a newer batch', async () => {
    const track = addTrack()
    addProduct('p1', 'Cursor', 'tracking', track.id)
    const daily = addRun('daily', { status: 'failed', error: '网络错误' }, TODAY, { productId: 'p1' })
    addRun('daily', { status: 'done' }, TODAY, { productId: 'p1' }) // the scheduler tried it once more, and it went through
    const check = addRun('verify', { status: 'failed', error: '模型出错' }, '2026-11-24', { productId: 'p1' })
    addRun('verify', { status: 'failed', error: '模型又出错' }, '2026-11-24', { productId: 'p1' }) // a later check that day: that one is the one to retry
    addRun('daily', { status: 'done' }, '2026-11-23', { productId: 'p1' })
    const afterDone = addRun('verify', { status: 'failed', error: '模型出错' }, '2026-11-23', { productId: 'p1' }) // that day's update is done
    const recommend = addRun('recommend', { status: 'failed', error: '模型出错' }, TODAY, { trackId: track.id })
    addRun('recommend', { status: 'done' }, TODAY, { trackId: track.id })

    for (const run of [daily, check, afterDone, recommend]) {
      const reply = await host.call('POST', `runs/${run.id}/retry`)
      expect(reply.status, run.kind).toBe(409)
      expect(reply.json()).toEqual({ error: '已经重新跑过了' })
    }
    await flush()
    expect(host.driver.runs).toEqual([])
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

  it('retries a failed summary of some days ago by writing that day\'s brief again, answering with the new run', async () => {
    const day = '2026-11-22' // three days ago: listed by GET runs, older than yesterday
    addProduct('p1', 'Cursor')
    const finding = addFinding('p1', {}, day)
    putBrief(day, [finding.id], { gist: 'Cursor：后台 Agent 正式上线' })
    const failed = addRun('synthesize', { status: 'failed', error: 'HTTP 503' }, day)
    host.complete.mockResolvedValueOnce({ text: 'Cursor 的后台 Agent 正式上线。', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 } })
    const { runId } = ok(await host.call('POST', `runs/${failed.id}/retry`)).json<ApiResponse<'POST runs/:id/retry'>>()
    expect(runId).not.toBe(failed.id)
    expect(repo.getRun(runId)).toMatchObject({ kind: 'synthesize', date: day })
    await vi.waitFor(() => { expect(repo.getBrief(day)!.gist).toBe('Cursor 的后台 Agent 正式上线。') })
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
