import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { FindingStatus, Id, ProductStatus, Track } from '../../src/core/types.ts'
import { matchFields, search, SEARCH_LIMIT, termsOf } from '../../src/host/search.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'

let dir: string
let db: Db
let repo: Repo
let agent: Track
let phone: Track
let now: Date

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-search-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  now = new Date('2026-11-28T09:00:00.000Z')
  repo = new Repo(db, () => now)
  agent = repo.createTrack({ name: 'Personal Agent', brief: '能替人办事的 Agent', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
  phone = repo.createTrack({ name: '手机 AI 助理', brief: '手机上的助理', dimensions: DEFAULT_DIMENSIONS.slice(0, 2), status: 'active' })
  addProduct('p1', '豆包·小豆', '字节跳动', [agent, phone])
  addProduct('p2', 'Muse', 'Meta', [agent])
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function addProduct(id: Id, name: string, company: string, tracks: Track[], status: ProductStatus = 'tracking') {
  repo.upsertProduct({ id, name, company, region: 'domestic', form: 'App', iconPath: null, officialDomains: [], status, dailyBudgetYuan: null })
  for (const t of tracks) repo.linkProduct(t.id, id)
}
function card(productId: Id, dimension: string, summary: string, body = `${summary}。`, bullets = ['要点']) {
  repo.addCardVersion({ productId, dimension, version: 1, summary, bullets, body, sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-26T00:00:00.000Z' })
}
function finding(productId: Id, headline: string, why: string, status: FindingStatus = 'verified') {
  now = new Date(now.getTime() + 60_000) // each a minute after the one before
  const run = repo.createRun({ kind: 'daily', date: '2026-11-27', trackId: null, productId })
  return repo.addFinding({
    productId, runId: run.id, headline, why, importance: 'notable', claimKind: 'self', sourceIds: [], status, statusNote: null,
    unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: headline, verifiedOn: null,
  })
}

describe('matching', () => {
  it('takes every word, folded for case and width', () => {
    expect(termsOf('  Muse  ＭＥＴＡ muse ')).toEqual(['muse', 'meta'])
    expect(termsOf('   ')).toEqual([])
  })

  it('finds a thing only when all the words are in its fields, and marks them in the field holding the most', () => {
    expect(matchFields(['小豆的会员', '按月收费，额度与豆包互通'], ['额度', '豆包'])).toEqual({ text: '按月收费，额度与豆包互通', marks: [{ start: 5, end: 7 }, { start: 8, end: 10 }] })
    expect(matchFields(['小豆的会员', '按月收费'], ['会员', '收费'])).toMatchObject({ text: '小豆的会员' }) // a word in each: the first field
    expect(matchFields(['小豆的会员'], ['会员', '年费'])).toBeNull()
    expect(matchFields(['anything'], [])).toBeNull()
  })

  it('reads full-width and capital letters as the same, and marks the text as it is written', () => {
    expect(matchFields(['Ｍｕｓｅ 上线'], ['muse'])).toEqual({ text: 'Ｍｕｓｅ 上线', marks: [{ start: 0, end: 4 }] })
  })

  it('leaves citation marks and line breaks out, and cuts a long field around the first match', () => {
    const body = `${'前'.repeat(40)}会员[1]按月收费\n\n${'后'.repeat(100)}`
    const hit = matchFields([body], ['会员'])!
    expect(hit.text.startsWith('…')).toBe(true)
    expect(hit.text.endsWith('…')).toBe(true)
    expect(hit.text).toContain('会员按月收费 ')
    expect(hit.text).not.toContain('[1]')
    expect(matchFields(['Cue Pro 会员 [2]。推论'], ['会员'])!.text).toBe('Cue Pro 会员。推论') // no space left before the stop
    expect(hit.text.slice(hit.marks[0]!.start, hit.marks[0]!.end)).toBe('会员')
  })
})

describe('search', () => {
  it('finds nothing for a blank query', () => {
    expect(search(repo, '  ')).toMatchObject({ products: [], tracks: [], cards: [], findings: [], topics: [] })
  })

  it('finds products by name or company, with their tracks', () => {
    expect(search(repo, '字节').products).toEqual([{ id: 'p1', name: '豆包·小豆', company: '字节跳动', tracks: ['Personal Agent', '手机 AI 助理'], snippet: { text: '字节跳动', marks: [{ start: 0, end: 2 }] } }])
    expect(search(repo, 'muse').products.map(p => p.name)).toEqual(['Muse'])
  })

  it('finds tracks by name or what they follow', () => {
    expect(search(repo, '办事').tracks).toMatchObject([{ id: agent.id, name: 'Personal Agent', snippet: { text: '能替人办事的 Agent' } }])
  })

  it('finds dossier cards in the dimensions the product’s tracks list, once per product', () => {
    card('p1', 'business', '订阅制', '按额度分级的订阅[1]，额度与豆包互通。', ['三档订阅'])
    card('p1', 'memory-old', '订阅也记得住') // a dimension no current track lists: not on the page, not found
    expect(search(repo, '订阅').cards).toEqual([{ productId: 'p1', product: '豆包·小豆', dimension: 'business', label: '商业化', snippet: expect.objectContaining({ text: '订阅制' }) }])
    expect(search(repo, '额度 豆包').cards).toMatchObject([{ snippet: { text: '按额度分级的订阅，额度与豆包互通。' } }])
  })

  it('finds findings the product page shows, newest first, by headline or why it matters', () => {
    finding('p1', '小豆上线记忆', '会员才有')
    finding('p2', 'Muse 调整会员价', '价格上调')
    finding('p1', '没站住的会员传闻', '无', 'unproven')
    finding('p1', '还没核查的会员消息', '无', 'pending')
    finding('p1', '撤回的会员消息', '无', 'withdrawn')
    const hits = search(repo, '会员').findings
    expect(hits.map(h => [h.headline, h.status])).toEqual([['没站住的会员传闻', 'unproven'], ['Muse 调整会员价', 'verified'], ['小豆上线记忆', 'verified']])
    expect(hits[2]).toEqual({ id: expect.any(String), productId: 'p1', product: '豆包·小豆', date: '2026-11-28', headline: '小豆上线记忆', status: 'verified', snippet: { text: '会员才有', marks: [{ start: 0, end: 2 }] } })
  })

  it('finds topics by question or their latest conclusions', () => {
    const topic = repo.createTopic({ trackId: agent.id, question: '谁的记忆做得好？', productIds: ['p1', 'p2'], cadence: 'once' })
    const draft = repo.addTopicDraft(topic.id)
    repo.updateTopicVersion(draft.id, { status: 'final', version: 1, cards: [{ title: '偏好', summary: '小豆记得住口味', bullets: ['b'], body: '正文', sourceIds: [], inferenceSpans: [], productIds: ['p1'] }] })
    expect(search(repo, '记忆').topics).toEqual([{ id: topic.id, question: '谁的记忆做得好？', track: 'Personal Agent', snippet: { text: '谁的记忆做得好？', marks: [{ start: 2, end: 4 }] } }])
    expect(search(repo, '口味').topics).toHaveLength(1)
  })

  it('leaves out candidates, and archived tracks with what only they hold', () => {
    addProduct('p3', '星芒', '某公司', [agent], 'candidate')
    const old = repo.createTrack({ name: '旧赛道', brief: '不看了', dimensions: DEFAULT_DIMENSIONS, status: 'archived' })
    addProduct('p4', '旧产品', '旧公司', [old])
    expect(search(repo, '星芒').products).toEqual([])
    expect(search(repo, '旧').products).toEqual([])
    expect(search(repo, '旧').tracks).toEqual([])
  })

  it('lists at most SEARCH_LIMIT of a kind and counts the rest', () => {
    for (let i = 0; i < SEARCH_LIMIT + 3; i++) finding('p2', `第 ${i} 条会员消息`, '无')
    const results = search(repo, '会员')
    expect(results.findings).toHaveLength(SEARCH_LIMIT)
    expect(results.more.findings).toBe(3)
  })
})
