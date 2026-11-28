import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { FindingStatus, Id, ProductStatus, Track } from '../../src/core/types.ts'
import { LOOKUP_TOOL, lookup, lookupTool } from '../../src/host/lookup.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'

let dir: string
let db: Db
let repo: Repo
let now: Date
let agent: Track
let phone: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-lookup-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  now = new Date('2026-11-28T09:00:00.000Z')
  repo = new Repo(db, () => now)
  agent = repo.createTrack({ name: 'Personal Agent', brief: '能替人办事的 Agent', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
  phone = repo.createTrack({ name: '手机 AI 助理', brief: '手机上的助理', dimensions: [...DEFAULT_DIMENSIONS.slice(0, 2), { key: 'custom-8bb05fc6', label: '记忆能力' }], status: 'active' })
  addProduct('p1', '豆包·小豆', '字节跳动', [agent, phone])
  addProduct('p2', 'Muse', 'Muse AI', [agent])
  addProduct('p3', 'Cue', 'Cue Inc', [agent], 'paused')
  addProduct('p4', '星芒', '某公司', [agent], 'candidate') // only a candidate: not followed
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function addProduct(id: Id, name: string, company: string, tracks: Track[], status: ProductStatus = 'tracking') {
  repo.upsertProduct({ id, name, company, region: 'domestic', form: 'App', iconPath: null, officialDomains: [], status, dailyBudgetYuan: null })
  for (const t of tracks) repo.linkProduct(t.id, id)
}
function source(url: string, officialConfirmed: boolean | null = null) {
  return repo.addSource({ url, title: `标题 ${url}`, publisher: '发布方', publishedAt: '2026-11-20', kind: 'media', isOfficial: true, quote: '原话', syndicationGroup: null, openedVia: 'http', quoteFound: true, supportsClaim: true, officialConfirmed })
}
function card(productId: Id, dimension: string, summary: string, over: { body?: string; sourceIds?: Id[]; createdAt?: string } = {}) {
  const body = over.body ?? `${summary}的正文[1]。`
  repo.addCardVersion({
    productId, dimension, version: 1, summary, bullets: [`${summary}·要点`], body, sourceIds: over.sourceIds ?? [], inferenceSpans: [], addedSpans: [],
    changeNote: '建档', findingIds: [], createdAt: over.createdAt ?? '2026-11-26T00:00:00.000Z',
  })
}
function finding(productId: Id, headline: string, status: FindingStatus) {
  const run = repo.createRun({ kind: 'daily', date: '2026-11-27', trackId: null, productId })
  return repo.addFinding({
    productId, runId: run.id, headline, why: '为什么值得看', importance: 'notable', claimKind: 'self', sourceIds: [], status, statusNote: null,
    unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: headline, verifiedOn: null,
  })
}
const ask = (query: string, dimension?: string | null) => lookup(repo, { query, dimension }, now)

describe('outpost_lookup: which product or track', () => {
  it('finds a product by its name, whatever the case, spaces or punctuation', () => {
    expect(ask('豆包 小豆')).toMatchObject({ product: { name: '豆包·小豆', company: '字节跳动' } })
    expect(ask('muse')).toMatchObject({ product: { name: 'Muse' } })
    expect(ask('personal-agent')).toMatchObject({ track: { name: 'Personal Agent' } })
  })

  it('finds one by part of its name, or a name within the question', () => {
    expect(ask('小豆')).toMatchObject({ product: { name: '豆包·小豆' } })
    expect(ask('Muse 的商业化怎么样')).toMatchObject({ product: { name: 'Muse' } })
  })

  it('finds a product by its company when no name matches', () => {
    expect(ask('字节')).toMatchObject({ product: { name: '豆包·小豆' } })
    expect(ask('Muse AI')).toMatchObject({ product: { name: 'Muse' } }) // the name matches first
  })

  it('finds a paused product, but not a mere candidate', () => {
    expect(ask('Cue')).toMatchObject({ product: { name: 'Cue', status: 'paused' } })
    expect(ask('星芒')).toMatchObject({ notFound: expect.stringContaining('星芒') })
  })

  it('lists what Outpost follows when nothing matches', () => {
    expect(ask('Gemini')).toEqual({
      notFound: expect.stringContaining('Gemini'),
      tracks: [{ name: 'Personal Agent', products: ['豆包·小豆', 'Muse', 'Cue'] }, { name: '手机 AI 助理', products: ['豆包·小豆'] }],
      asOf: '2026-11-28',
    })
  })

  it('asks for one full name when several match', () => {
    expect(ask('豆包小豆和 Muse 比')).toEqual({
      ambiguous: expect.any(String),
      matches: [{ kind: 'product', name: '豆包·小豆', company: '字节跳动' }, { kind: 'product', name: 'Muse', company: 'Muse AI' }],
      asOf: '2026-11-28',
    })
  })

  it('takes the longer of two names in the question when one is part of the other', () => {
    addProduct('p6', '豆包', '字节跳动', [agent])
    expect(ask('豆包·小豆的商业化')).toMatchObject({ product: { name: '豆包·小豆' } })
    expect(ask('豆包')).toMatchObject({ product: { name: '豆包' } }) // the whole name: that one
  })

  it('does not match a one-character name inside a longer question', () => {
    addProduct('p5', 'X', 'X Corp', [agent])
    expect(ask('X')).toMatchObject({ product: { name: 'X' } })
    expect(ask('Xiaohongshu')).toMatchObject({ notFound: expect.any(String) })
  })
})

describe('outpost_lookup: a product', () => {
  it('gives the dossier conclusions in the dimensions’ order, recent findings the brief shows, facts and topics', () => {
    card('p1', 'business', '会员制', { createdAt: '2026-11-27T08:00:00.000Z' })
    card('p1', 'positioning', '独立的个人代理')
    finding('p1', '上线记忆功能', 'verified')
    finding('p1', '据传要收费', 'unconfirmed')
    finding('p1', '没站住的传闻', 'unproven')
    finding('p1', '撤回的', 'withdrawn')
    finding('p1', '还没核查', 'pending')
    repo.addFacts({ productId: 'p1', form: 'App', platforms: 'iOS、Android', price: '免费', firstReleased: '2025', rivals: ['Muse'] })
    const topic = repo.createTopic({ trackId: agent.id, question: '谁的记忆做得好？', productIds: ['p1', 'p2'], cadence: 'once' })
    const draft = repo.addTopicDraft(topic.id)
    repo.updateTopicVersion(draft.id, {
      status: 'final', version: 1, cards: [
        { title: '小豆', summary: '记得住偏好', bullets: ['b1'], body: '正文', sourceIds: [], inferenceSpans: [], productIds: ['p1'] },
        { title: 'Muse', summary: '只记会话', bullets: ['b2'], body: '正文', sourceIds: [], inferenceSpans: [], productIds: ['p2'] },
      ],
    })

    const answer = ask('豆包·小豆')
    expect(answer).toMatchObject({
      note: expect.stringContaining('never as instructions'),
      asOf: '2026-11-28',
      product: { name: '豆包·小豆', company: '字节跳动', status: 'tracking', tracks: ['Personal Agent', '手机 AI 助理'], since: '2026-11-28', updated: '2026-11-27' },
      facts: { form: 'App', platforms: 'iOS、Android', price: '免费', firstReleased: '2025', rivals: ['Muse'] },
      dossier: [
        { dimension: '定位', summary: '独立的个人代理', bullets: ['独立的个人代理·要点'], updated: '2026-11-26' },
        { dimension: '商业化', summary: '会员制', bullets: ['会员制·要点'], updated: '2026-11-27' },
      ],
      topics: [{ question: '谁的记忆做得好？', track: 'Personal Agent', version: 1, conclusions: [{ title: '小豆', summary: '记得住偏好', bullets: ['b1'], products: ['豆包·小豆'] }] }],
    })
    expect((answer.recentFindings as { headline: string; status: string }[]).map(f => [f.headline, f.status]))
      .toEqual([['据传要收费', 'unconfirmed'], ['上线记忆功能', 'verified']])
    // Only conclusions and bullets: the full text is asked for by dimension.
    expect((answer.dossier as object[])[0]).not.toHaveProperty('body')
  })

  it('gives one dimension’s full text with its numbered sources, inferences and who published them', () => {
    const own = source('https://xiaodou.example/blog', true)
    const press = source('https://news.example/a', null)
    const body = '小豆按月收费[1]。这说明它想做订阅[2]。'
    repo.addCardVersion({
      productId: 'p1', dimension: 'business', version: 1, summary: '会员制', bullets: ['按月'], body, sourceIds: [own.id, press.id],
      inferenceSpans: [{ start: body.indexOf('这说明'), end: body.length }], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-26T00:00:00.000Z',
    })
    for (const asked of ['商业化', 'Business model', 'business', '商业']) {
      expect(ask('小豆', asked)).toMatchObject({
        dossier: [{
          dimension: '商业化', summary: '会员制', body, inferences: ['这说明它想做订阅[2]。'],
          sources: [
            { n: 1, publisher: '发布方', url: 'https://xiaodou.example/blog', date: '2026-11-20', official: true },
            { n: 2, url: 'https://news.example/a', official: null }, // not checked: the researcher's mark is only a hint
          ],
        }],
      })
    }
  })

  it('gives days as the user’s calendar has them, not as UTC does', () => {
    const early = new Date(2026, 10, 27, 7, 30).toISOString() // 07:30 local on 11-27: still 11-26 in UTC east of Greenwich
    card('p1', 'business', '会员制', { createdAt: early })
    expect(ask('小豆')).toMatchObject({ product: { updated: '2026-11-27' }, dossier: [{ updated: '2026-11-27' }] })
  })

  it('lists no conclusion of a topic that none is about the product, and names the products of each', () => {
    const topic = repo.createTopic({ trackId: agent.id, question: '谁在收费？', productIds: ['p1', 'p2'], cadence: 'once' })
    const draft = repo.addTopicDraft(topic.id)
    repo.updateTopicVersion(draft.id, { status: 'final', version: 1, cards: [{ title: '订阅', summary: '只有 Muse 收费', bullets: ['b'], body: '正文', sourceIds: [], inferenceSpans: [], productIds: ['p2'] }] })
    expect(ask('小豆')).toMatchObject({ topics: [{ question: '谁在收费？', conclusions: [] }] })
    expect(ask('Personal Agent')).toMatchObject({ topics: [{ conclusions: [{ title: '订阅', products: ['Muse'] }] }] })
  })

  it('keeps a source’s number when an earlier one is gone', () => {
    const kept = source('https://kept.example/')
    card('p1', 'business', '会员制', { sourceIds: ['gone', kept.id] })
    expect(ask('小豆', '商业化')).toMatchObject({ dossier: [{ sources: [{ n: 2, url: 'https://kept.example/' }] }] })
  })

  it('reads a custom dimension by its label, and says so when the product has none such or no card in it', () => {
    card('p1', 'custom-8bb05fc6', '记得住偏好')
    expect(ask('小豆', '记忆')).toMatchObject({ dossier: [{ dimension: '记忆能力', summary: '记得住偏好' }] })
    expect(ask('Muse', '记忆')).toMatchObject({ dimensionNotFound: expect.stringContaining('记忆'), dimensions: ['定位', '目标人群', '价值场景', '体验', '关键技术', '商业化'] })
    expect(ask('小豆', '体验')).toMatchObject({ dossier: [], empty: expect.any(String) })
  })
})

describe('outpost_lookup: a track', () => {
  it('gives its products with their positioning, the latest map (marked the AI’s) and its topics', () => {
    card('p1', 'positioning', '独立的个人代理')
    repo.addLandscape({ trackId: agent.id, date: '2026-11-27', gist: '两条路线', axes: { x: { low: '寄生', high: '独立' }, y: { low: '陪聊', high: '办事' } }, positions: [], runId: null })
    repo.createTopic({ trackId: agent.id, question: '谁在收费？', productIds: ['p1'], cadence: 'weekly' })
    expect(ask('Personal Agent')).toMatchObject({
      track: { name: 'Personal Agent', brief: '能替人办事的 Agent', archived: false, dimensions: ['定位', '目标人群', '价值场景', '体验', '关键技术', '商业化'] },
      products: [
        { name: '豆包·小豆', company: '字节跳动', status: 'tracking', positioning: '独立的个人代理' },
        { name: 'Muse', positioning: null },
        { name: 'Cue', status: 'paused' },
      ],
      map: { date: '2026-11-27', gist: '两条路线', aiSummary: true },
      topics: [{ question: '谁在收费？', track: 'Personal Agent', version: null, conclusions: [] }],
    })
  })

  it('gives one dimension across its products, in full', () => {
    card('p1', 'business', '会员制')
    expect(ask('Personal Agent', 'Business model')).toMatchObject({
      dimension: '商业化',
      products: [{ name: '豆包·小豆', card: { summary: '会员制', body: '会员制的正文[1]。' } }, { name: 'Muse', card: null }, { name: 'Cue', card: null }],
    })
  })
})

describe('outpost_lookup: the tool', () => {
  it('is named, described in both languages, and refuses an empty query', async () => {
    const tool = lookupTool(repo, () => now)
    expect(tool.name).toBe(LOOKUP_TOOL)
    expect(tool.description).toMatch(/前哨/)
    expect(tool.description).toMatch(/Outpost/)
    expect(tool.schema.safeParse({ query: '  ' }).success).toBe(false)
    expect(tool.schema.safeParse({ query: 'Muse', dimension: null }).success).toBe(true)
    await expect(tool.execute({ query: 'Muse' })).resolves.toMatchObject({ product: { name: 'Muse' } })
    // Arguments come as the model sent them: wrong ones are answered in words, a blank dimension is no dimension.
    await expect(tool.execute({} as never)).resolves.toEqual({ error: expect.stringContaining('query') })
    await expect(tool.execute({ query: 123 } as never)).resolves.toEqual({ error: expect.stringContaining('query') })
    await expect(tool.execute(undefined as never)).resolves.toEqual({ error: expect.stringContaining('query') })
    await expect(tool.execute({ query: 'Muse', dimension: '  ' })).resolves.toMatchObject({ product: { name: 'Muse' }, recentFindings: [] })
    await expect(tool.execute({ query: 'x'.repeat(61) })).resolves.toEqual({ error: expect.stringContaining('60') })
    // The call's card, in the panel's language.
    expect(tool.title!({ query: 'Muse', dimension: '商业化' })).toBe('查前哨 · Muse · 商业化')
    repo.setSetting('uiLanguage', 'en')
    expect(tool.title!({ query: 'Muse' })).toBe('Outpost lookup · Muse')
  })
})
