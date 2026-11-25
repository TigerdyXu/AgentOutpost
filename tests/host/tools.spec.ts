import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { findingKey } from '../../src/core/dedupe.ts'
import type { Finding, Product, Run, Source, Track } from '../../src/core/types.ts'
import { researchTools, type ToolScope } from '../../src/host/tools.ts'
import type { IconFetcher } from '../../src/host/ports.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'

const DAY_MS = 24 * 60 * 60 * 1000
type Kind = Parameters<typeof researchTools>[0]

let dir: string
let db: Db
let repo: Repo
let time: Date
let track: Track
let product: Product
let run: Run
let done: string[]
let icons: IconFetcher & { fetch: ReturnType<typeof vi.fn> }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-tools-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  time = new Date(2026, 10, 25, 9, 0, 0) // local wall-clock, so "N days ago" means the same in every time zone
  repo = new Repo(db, () => time)
  track = repo.createTrack({ name: 'AI 编程助手', brief: '盯住编程类 Agent', dimensions: [{ key: 'positioning', label: '定位' }, { key: 'pricing', label: '价格' }], status: 'active' })
  product = repo.upsertProduct({ name: 'Cursor', company: 'Anysphere', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: ['cursor.com'], status: 'tracking', dailyBudgetYuan: null })
  repo.linkProduct(track.id, product.id)
  run = repo.createRun({ kind: 'daily', date: '2026-11-25', trackId: track.id, productId: product.id })
  done = []
  icons = { fetch: vi.fn(async () => null) }
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const scopeOf = (over: Partial<ToolScope> = {}): ToolScope =>
  ({ repo, runId: run.id, trackId: track.id, productId: product.id, now: () => time, icons, onDone: s => { done.push(s) }, ...over })
/** The tools of one kind of run as a function: `call(name, args)`. Tool state (such as the per-item allowance) lives as long as the box. */
const toolbox = (kind: Kind, over: Partial<ToolScope> = {}) => {
  const tools = researchTools(kind, scopeOf(over))
  return (name: string, args?: unknown): Promise<unknown> => {
    const tool = tools.find(t => t.name === name)
    if (!tool) throw new Error(`${kind} has no tool ${name}`)
    return tool.execute(args)
  }
}

const source = (over: Record<string, unknown> = {}) => ({
  url: 'https://cursor.com/changelog/1-2', title: 'Cursor 1.2 更新日志', publisher: 'Cursor', publishedAt: '2026-11-24', kind: 'official', isOfficial: true, quote: '推出新的团队定价', ...over,
})
const finding = { headline: 'Cursor 推出团队定价', why: '团队版每人每月 40 美元', importance: 'major', claimKind: 'self', dimensions: ['pricing'], inference: false, sources: [source()] }
const card = {
  dimension: 'pricing', summary: '个人免费，团队按人收费', bullets: ['免费版有额度', '团队版 40 美元'], body: '个人版免费[1]。团队版按人收费，估计会有批量折扣[2]。',
  sources: [source(), source({ url: 'https://cursor.com/pricing', title: '定价页', quote: '团队版 40 美元' })], inferenceQuotes: ['估计会有批量折扣'],
}
const candidate = {
  name: 'Windsurf', company: 'Codeium', region: 'overseas', form: 'IDE', oneLiner: '带 Agent 的编辑器', tier: 'strong', reason: '同类里更新最勤',
  officialUrl: 'https://www.windsurf.com/', iconUrl: 'https://cdn.example/windsurf.png', articles: [{ url: 'https://news.example/a', title: '报道一', publishedAt: '2026-11-24' }],
}
const facts = { form: 'IDE', platforms: 'macOS / Windows / Linux', price: '免费版；Pro 每月 20 美元', firstReleased: '2023', rivals: ['Windsurf', 'Copilot'] }

const idOf = (result: unknown, key: string): string => {
  const value = (result as Record<string, unknown>)[key]
  if (typeof value !== 'string') throw new Error(`no ${key} in ${JSON.stringify(result)}`)
  return value
}
/** A source and a finding written straight into the store, as an earlier run would have left them. */
const seedFinding = (over: Partial<Omit<Finding, 'id' | 'createdAt'>> = {}, sourceOver: Partial<Omit<Source, 'id'>> = {}) => {
  const s = repo.addSource({ url: 'https://seed.example/1', title: '旧报道', publisher: '某媒体', publishedAt: null, kind: 'media', isOfficial: false, quote: '原话', syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null, ...sourceOver })
  const f = repo.addFinding({
    productId: product.id, runId: run.id, headline: '旧发现', why: '旧', importance: 'notable', claimKind: 'third-party', sourceIds: [s.id], status: 'pending', statusNote: null,
    unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: 'seed', ...over,
  })
  return { source: s, finding: f }
}
const atDaysAgo = <T>(days: number, fn: () => T): T => {
  const saved = time
  time = new Date(saved.getTime() - days * DAY_MS)
  try { return fn() } finally { time = saved }
}

describe('researchTools', () => {
  it('gives each run kind exactly its tools', () => {
    const names = (kind: Kind) => researchTools(kind, scopeOf()).map(t => t.name)
    expect(names('recommend')).toEqual(['outpost_submit_candidate', 'outpost_done'])
    expect(names('baseline')).toEqual(['outpost_read', 'outpost_submit_card', 'outpost_submit_facts', 'outpost_done'])
    expect(names('daily')).toEqual(['outpost_read', 'outpost_submit_finding', 'outpost_propose_card_edit', 'outpost_submit_facts', 'outpost_done'])
    expect(names('verify')).toEqual(['outpost_read_pending', 'outpost_report_check', 'outpost_add_source', 'outpost_done'])
    expect(names('followup')).toEqual(['outpost_read'])
  })

  it('describes every tool, and every schema can be turned into JSON Schema for the model', () => {
    for (const kind of ['recommend', 'baseline', 'daily', 'verify', 'followup'] as const)
      for (const tool of researchTools(kind, scopeOf())) {
        expect(tool.description.length, tool.name).toBeGreaterThan(20)
        const json = z.toJSONSchema(tool.schema) as { type?: string }
        expect(json.type, tool.name).toBe('object')
      }
  })

  it('never throws to the agent for arguments that are missing, empty or of the wrong type', async () => {
    for (const kind of ['recommend', 'baseline', 'daily', 'verify', 'followup'] as const)
      for (const tool of researchTools(kind, scopeOf()))
        for (const args of [undefined, null, 'oops', 42, [], { unknownField: 1 }]) {
          const result = await tool.execute(args)
          if (tool.name === 'outpost_read' || tool.name === 'outpost_read_pending') continue // these take no arguments, so there is nothing to get wrong
          expect(result, `${tool.name} ${JSON.stringify(args)}`).toMatchObject({ error: expect.any(String) })
        }
  })
})

describe('outpost_submit_finding', () => {
  it('rejects an over-long headline with a readable message', async () => {
    const call = toolbox('daily')
    const r = await call('outpost_submit_finding', { ...finding, headline: '长'.repeat(31) })
    expect(r).toMatchObject({ error: expect.stringContaining('headline') })
    expect((r as { error: string }).error).toContain('30')
    expect(repo.findingsOfProduct(product.id)).toEqual([])
  })

  it('names the field for every kind of mistake: missing, wrong type, no sources, a quote that is empty or too long', async () => {
    const call = toolbox('daily')
    const error = async (args: unknown) => ((await call('outpost_submit_finding', args)) as { error: string }).error
    expect(await error({ ...finding, why: undefined })).toContain('why')
    expect(await error({ ...finding, importance: 'huge' })).toContain('importance')
    expect(await error({ ...finding, sources: [] })).toContain('sources')
    expect(await error({ ...finding, sources: [source({ quote: '' })] })).toContain('sources[0].quote')
    expect(await error({ ...finding, sources: [source({ quote: '字'.repeat(201) })] })).toContain('sources[0].quote')
    expect(await error({ ...finding, sources: [source({ title: '题'.repeat(81) })] })).toContain('sources[0].title')
    expect(await error({ ...finding, sources: [source({ publisher: '社'.repeat(31) })] })).toContain('sources[0].publisher')
    expect(repo.findingsOfProduct(product.id)).toEqual([])
  })

  it('accepts only absolute http(s) addresses as sources', async () => {
    const call = toolbox('daily')
    for (const url of ['/changelog/1-2', 'cursor.com/changelog', 'javascript:alert(1)', 'file:///etc/passwd', '']) {
      const r = await call('outpost_submit_finding', { ...finding, sources: [source({ url })] })
      expect(r, url).toMatchObject({ error: expect.stringContaining('sources[0].url') })
    }
    expect(repo.findingsOfProduct(product.id)).toEqual([])
  })

  it('rejects a duplicate finding', async () => {
    const call = toolbox('daily')
    expect(await call('outpost_submit_finding', finding)).toMatchObject({ findingId: expect.any(String) })
    const again = await call('outpost_submit_finding', { ...finding, headline: '别的说法' }) // same article, new words
    expect(again).toMatchObject({ error: expect.stringContaining('重复') })
    expect((again as { error: string }).error).toBe('这条和已有发现重复：Cursor 推出团队定价')
    expect(repo.findingsOfProduct(product.id)).toHaveLength(1)
  })

  it('rejects the same news found again through another repost, or submitted again the next day', async () => {
    const call = toolbox('daily')
    await call('outpost_submit_finding', finding)
    const repost = await call('outpost_submit_finding', { ...finding, headline: 'Cursor 推出团队定价！', sources: [source({ url: 'https://36kr.example/p/123', publisher: '36氪', kind: 'media', isOfficial: false })] })
    expect(repost).toMatchObject({ error: expect.stringContaining('重复') })

    time = new Date(time.getTime() + DAY_MS) // the next day's run, a new run
    const nextRun = repo.createRun({ kind: 'daily', date: '2026-11-26', trackId: track.id, productId: product.id })
    const nextDay = toolbox('daily', { runId: nextRun.id })
    expect(await nextDay('outpost_submit_finding', { ...finding, sources: [source({ url: 'https://other.example/again' })] })).toMatchObject({ error: expect.stringContaining('重复') })
    expect(repo.findingsOfProduct(product.id)).toHaveLength(1)
  })

  it('compares against the last 14 days only', async () => {
    atDaysAgo(15, () => seedFinding({ headline: '老消息', dedupeKey: 'old' }, { url: 'https://seed.example/old' }))
    atDaysAgo(13, () => seedFinding({ headline: '近消息', dedupeKey: 'recent' }, { url: 'https://seed.example/recent' }))
    const call = toolbox('daily')
    const oldNews = await call('outpost_submit_finding', { ...finding, headline: '老消息', sources: [source({ url: 'https://seed.example/old' })] })
    expect(oldNews).toMatchObject({ findingId: expect.any(String) })
    const recentNews = await call('outpost_submit_finding', { ...finding, headline: '近消息', sources: [source({ url: 'https://seed.example/recent' })] })
    expect(recentNews).toMatchObject({ error: '这条和已有发现重复：近消息' })
  })

  it('keeps only one of two identical submissions made at the same moment', async () => {
    const call = toolbox('daily')
    const results = await Promise.all([call('outpost_submit_finding', finding), call('outpost_submit_finding', finding)])
    expect(results.filter(r => 'findingId' in (r as object))).toHaveLength(1)
    expect(results.filter(r => 'error' in (r as object))).toHaveLength(1)
    expect(repo.findingsOfProduct(product.id)).toHaveLength(1)
  })

  it('stores a pending finding with its sources, and returns its id', async () => {
    const call = toolbox('daily')
    const raw = 'https://www.cursor.com/changelog/1-2/?utm_source=x'
    const r = await call('outpost_submit_finding', { ...finding, inference: true, dimensions: ['pricing', 'positioning'], sources: [source({ url: raw }), source({ url: 'https://36kr.example/p/9', kind: 'media', isOfficial: false, publisher: '36氪', quote: '团队版每人每月 40 美元' })] })
    const stored = repo.findingsOfProduct(product.id)
    expect(stored).toHaveLength(1)
    const f = stored[0]!
    expect(r).toEqual({ findingId: f.id })
    expect(f).toMatchObject({
      productId: product.id, runId: run.id, headline: finding.headline, why: finding.why, importance: 'major', claimKind: 'self', dimensions: ['pricing', 'positioning'], inference: true,
      status: 'pending', statusNote: null, unconfirmedUntil: null, read: false, late: false, createdAt: time.toISOString(),
    })
    expect(f.dedupeKey).toBe(findingKey(product.id, finding.headline, [raw, 'https://36kr.example/p/9']))
    const sources = repo.getSources(f.sourceIds)
    expect(sources.map(s => s.url)).toEqual([raw, 'https://36kr.example/p/9']) // the raw address is kept, not the canonical form
    expect(sources[0]).toEqual({
      id: f.sourceIds[0], url: raw, title: 'Cursor 1.2 更新日志', publisher: 'Cursor', publishedAt: '2026-11-24', kind: 'official', isOfficial: true, quote: '推出新的团队定价',
      syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null,
    })
    expect(sources[1]).toMatchObject({ kind: 'media', isOfficial: false, quote: '团队版每人每月 40 美元' })
  })

  it('stores publish dates as YYYY-MM-DD, and a date it cannot read as none, without refusing the finding', async () => {
    const call = toolbox('daily')
    const dates = ['2026年11月24日', '2026/11/23', '2026.11.22', '2026-11-21T10:30:00', 'last Tuesday', undefined]
    const r = await call('outpost_submit_finding', { ...finding, sources: dates.map((publishedAt, i) => source({ url: `https://news.example/${i}`, publishedAt })) })
    expect(r).toMatchObject({ findingId: expect.any(String) })
    expect(repo.getSources(repo.findingsOfProduct(product.id)[0]!.sourceIds).map(s => s.publishedAt)).toEqual(['2026-11-24', '2026-11-23', '2026-11-22', '2026-11-21', null, null])
  })

  it('rejects a dimension the product does not have, and says which ones it has', async () => {
    const call = toolbox('daily')
    const r = await call('outpost_submit_finding', { ...finding, dimensions: ['pricing', 'privacy'] })
    expect(r).toMatchObject({ error: expect.stringContaining('dimensions') })
    expect((r as { error: string }).error).toContain('privacy')
    expect((r as { error: string }).error).toContain('positioning')
    expect(repo.findingsOfProduct(product.id)).toEqual([])
  })

  it('refuses when the run is not about one product', async () => {
    const call = toolbox('daily', { productId: null })
    expect(await call('outpost_submit_finding', finding)).toMatchObject({ error: expect.stringContaining('产品') })
  })
})

describe('outpost_submit_card', () => {
  it('writes the sources and one pending card edit, and returns its id', async () => {
    const call = toolbox('baseline')
    const r = await call('outpost_submit_card', card)
    const edits = repo.pendingCardEdits(product.id)
    expect(edits).toHaveLength(1)
    const edit = edits[0]!
    expect(r).toEqual({ cardEditId: edit.id })
    expect(edit).toMatchObject({ productId: product.id, dimension: 'pricing', summary: card.summary, bullets: card.bullets, body: card.body, changeNote: '建档', findingIds: [], status: 'pending' })
    expect(repo.getSources(edit.sourceIds).map(s => s.url)).toEqual(['https://cursor.com/changelog/1-2', 'https://cursor.com/pricing'])
    const start = card.body.indexOf('估计会有批量折扣')
    expect(edit.inferenceSpans).toEqual([{ start, end: start + '估计会有批量折扣'.length }])
    expect(card.body.slice(edit.inferenceSpans[0]!.start, edit.inferenceSpans[0]!.end)).toBe('估计会有批量折扣')
  })

  it('marks the first place each inference quote occurs, and merges quotes that overlap', async () => {
    const call = toolbox('baseline')
    const body = '甲乙丙丁戊己庚辛。甲乙丙丁。'
    await call('outpost_submit_card', { ...card, body: body, sources: [card.sources[0]], inferenceQuotes: ['丙丁戊', '甲乙丙', '己庚'] })
    // 甲乙丙 [0,3) and 丙丁戊 [2,5) overlap; 己庚 [5,7) touches it: one span. The later 甲乙丙丁 is not marked.
    expect(repo.pendingCardEdits(product.id)[0]!.inferenceSpans).toEqual([{ start: 0, end: 7 }])
  })

  it('takes no inference quotes to mean no inference', async () => {
    const call = toolbox('baseline')
    const { inferenceQuotes: _omitted, ...withoutQuotes } = card
    expect(await call('outpost_submit_card', { ...withoutQuotes, body: '个人版免费[1]。', sources: [card.sources[0]] })).toMatchObject({ cardEditId: expect.any(String) })
    expect(repo.pendingCardEdits(product.id)[0]!.inferenceSpans).toEqual([])
  })

  it('rejects an inference quote that is not in the body', async () => {
    const call = toolbox('baseline')
    const r = await call('outpost_submit_card', { ...card, inferenceQuotes: ['估计会有批量折扣', '这句话正文里没有'] })
    expect(r).toMatchObject({ error: expect.stringContaining('inferenceQuotes') })
    expect((r as { error: string }).error).toContain('这句话正文里没有')
    expect(repo.pendingCardEdits(product.id)).toEqual([])
  })

  it('rejects a card for a dimension the product does not have, and says which ones it has', async () => {
    const call = toolbox('baseline')
    const r = await call('outpost_submit_card', { ...card, dimension: 'privacy' })
    expect(r).toMatchObject({ error: expect.stringContaining('dimension') })
    expect((r as { error: string }).error).toContain('privacy')
    expect((r as { error: string }).error).toContain('pricing')
    expect(repo.pendingCardEdits(product.id)).toEqual([])
  })

  it('judges the dimension by every track the product is in', async () => {
    const other = repo.createTrack({ name: '隐私', brief: '', dimensions: [{ key: 'privacy', label: '隐私' }], status: 'active' })
    repo.linkProduct(other.id, product.id)
    expect(await toolbox('baseline')('outpost_submit_card', { ...card, dimension: 'privacy' })).toMatchObject({ cardEditId: expect.any(String) })
  })

  it('enforces the length limits', async () => {
    const call = toolbox('baseline')
    const error = async (over: Record<string, unknown>) => ((await call('outpost_submit_card', { ...card, ...over })) as { error: string }).error
    expect(await error({ summary: '长'.repeat(31) })).toContain('summary')
    expect(await error({ bullets: [] })).toContain('bullets')
    expect(await error({ bullets: ['一', '二', '三', '四'] })).toContain('bullets')
    expect(await error({ bullets: ['长'.repeat(41)] })).toContain('bullets[0]')
    expect(await error({ body: '长'.repeat(1501), inferenceQuotes: [] })).toContain('body')
    expect(await error({ sources: [] })).toContain('sources')
    expect(repo.pendingCardEdits(product.id)).toEqual([])
    expect(await call('outpost_submit_card', { ...card, summary: '长'.repeat(30), bullets: ['长'.repeat(40), '二', '三'], body: '长'.repeat(1500), sources: [card.sources[0]], inferenceQuotes: [] })).toMatchObject({ cardEditId: expect.any(String) })
  })

  it('rejects a body that cites a source it does not have', async () => {
    const call = toolbox('baseline')
    const r = await call('outpost_submit_card', { ...card, body: '个人版免费[1]。团队版按人收费[3]。', inferenceQuotes: [] })
    expect(r).toMatchObject({ error: expect.stringContaining('[3]') })
    expect(await call('outpost_submit_card', { ...card, body: '个人版免费[0]。', inferenceQuotes: [] })).toMatchObject({ error: expect.stringContaining('[0]') })
    expect(repo.pendingCardEdits(product.id)).toEqual([])
  })
})

describe('outpost_propose_card_edit', () => {
  const propose = { ...card, changeNote: '团队版降价', findingIds: [] as string[] }

  it('writes a pending card edit that points at the findings it rests on', async () => {
    const call = toolbox('daily')
    const found = idOf(await call('outpost_submit_finding', finding), 'findingId')
    const r = await call('outpost_propose_card_edit', { ...propose, findingIds: [found] })
    const edit = repo.pendingCardEdits(product.id)[0]!
    expect(r).toEqual({ cardEditId: edit.id })
    expect(edit).toMatchObject({ dimension: 'pricing', summary: card.summary, body: card.body, changeNote: '团队版降价', findingIds: [found], status: 'pending' })
    expect(repo.getSources(edit.sourceIds)).toHaveLength(2)
    const start = card.body.indexOf('估计会有批量折扣')
    expect(edit.inferenceSpans).toEqual([{ start, end: start + 8 }])
  })

  it('rejects findings that this run did not submit, or that do not exist', async () => {
    const call = toolbox('daily')
    const mine = idOf(await call('outpost_submit_finding', finding), 'findingId')
    const earlierRun = repo.createRun({ kind: 'daily', date: '2026-11-24', trackId: track.id, productId: product.id })
    const { finding: theirs } = seedFinding({ runId: earlierRun.id })
    const r = await call('outpost_propose_card_edit', { ...propose, findingIds: [mine, theirs.id, 'no-such-id'] })
    expect(r).toMatchObject({ error: expect.stringContaining('findingIds') })
    expect((r as { error: string }).error).toContain(theirs.id)
    expect((r as { error: string }).error).toContain('no-such-id')
    expect((r as { error: string }).error).not.toContain(mine)
    expect(repo.pendingCardEdits(product.id)).toEqual([])
  })

  it('rejects an empty list of findings, an over-long change note, an unknown dimension and an inference quote that is not in the body', async () => {
    const call = toolbox('daily')
    const found = idOf(await call('outpost_submit_finding', finding), 'findingId')
    const error = async (over: Record<string, unknown>) => ((await call('outpost_propose_card_edit', { ...propose, findingIds: [found], ...over })) as { error: string }).error
    expect(await error({ findingIds: [] })).toContain('findingIds')
    expect(await error({ changeNote: '长'.repeat(31) })).toContain('changeNote')
    expect(await error({ dimension: 'privacy' })).toContain('dimension')
    expect(await error({ inferenceQuotes: ['正文里没有这句'] })).toContain('inferenceQuotes')
    expect(repo.pendingCardEdits(product.id)).toEqual([])
  })
})

describe('outpost_submit_facts', () => {
  it('stores the facts as the next version', async () => {
    const call = toolbox('baseline')
    expect(await call('outpost_submit_facts', facts)).toEqual({ factsVersion: 1 })
    expect(repo.latestFacts(product.id)).toMatchObject({ productId: product.id, version: 1, ...facts })
    expect(await call('outpost_submit_facts', { ...facts, price: '免费版；Pro 每月 25 美元' })).toEqual({ factsVersion: 2 })
    expect(repo.latestFacts(product.id)).toMatchObject({ version: 2, price: '免费版；Pro 每月 25 美元' })
  })

  it('does not make a new version out of the same facts', async () => {
    const call = toolbox('daily')
    await call('outpost_submit_facts', facts)
    expect(await call('outpost_submit_facts', facts)).toEqual({ factsVersion: 1, unchanged: true })
    expect(repo.latestFacts(product.id)!.version).toBe(1)
  })

  it('allows at most 5 rivals and rejects over-long values', async () => {
    const call = toolbox('baseline')
    expect(await call('outpost_submit_facts', { ...facts, rivals: ['一', '二', '三', '四', '五', '六'] })).toMatchObject({ error: expect.stringContaining('rivals') })
    expect(await call('outpost_submit_facts', { ...facts, form: '长'.repeat(21) })).toMatchObject({ error: expect.stringContaining('form') })
    expect(await call('outpost_submit_facts', { ...facts, rivals: undefined })).toMatchObject({ error: expect.stringContaining('rivals') })
    expect(repo.latestFacts(product.id)).toBeNull()
    expect(await call('outpost_submit_facts', { ...facts, rivals: ['一', '二', '三', '四', '五'] })).toMatchObject({ factsVersion: 1 })
  })
})

describe('outpost_submit_candidate', () => {
  const recommend = (over: Partial<ToolScope> = {}) => toolbox('recommend', { productId: null, ...over })

  it('pre-selects strong candidates and computes heat', async () => {
    const call = recommend()
    const dated = ['2026-11-24', '2026/11/23', '2026年11月22日', '2026.11.21', '2026-11-20T10:00:00', 'sometime']
    const strong = await call('outpost_submit_candidate', { ...candidate, articles: dated.map((publishedAt, i) => ({ url: `https://news.example/${i}`, title: `报道 ${i}`, publishedAt })) })
    const consider = await call('outpost_submit_candidate', { ...candidate, name: 'Cline', company: 'Cline Inc', tier: 'consider' })
    const excluded = await call('outpost_submit_candidate', { ...candidate, name: 'Tabnine', company: 'Tabnine Ltd', tier: 'excluded', reason: '只做补全，不是 Agent' })
    const candidates = repo.listCandidates(track.id, run.id)
    expect(candidates.map(c => c.id)).toEqual([idOf(strong, 'candidateId'), idOf(consider, 'candidateId'), idOf(excluded, 'candidateId')])
    expect(candidates.map(c => [c.tier, c.selected])).toEqual([['strong', true], ['consider', false], ['excluded', false]])
    // Six articles were found, five of them dated, all within the newest week.
    expect(candidates[0]!.heat).toEqual({ foundCount: 6, datedWeekly: [0, 0, 0, 0, 5], trend: 'up', showBars: true })
    expect(candidates[1]!.heat).toMatchObject({ foundCount: 1, showBars: false, trend: 'unknown' })
  })

  it('writes the product as a candidate in the track, the batch being this run', async () => {
    const call = recommend()
    await call('outpost_submit_candidate', candidate)
    const [c] = repo.listCandidates(track.id)
    expect(c).toMatchObject({ trackId: track.id, batchId: run.id, tier: 'strong', oneLiner: '带 Agent 的编辑器', reason: '同类里更新最勤' })
    expect(repo.getProduct(c!.productId)).toMatchObject({ name: 'Windsurf', company: 'Codeium', region: 'overseas', form: 'IDE', status: 'candidate', iconPath: null, officialDomains: ['windsurf.com'] })
    expect(repo.latestBatchId(track.id)).toBe(run.id)
  })

  it('leaves the status of a product that is already tracked alone', async () => {
    const call = recommend()
    await call('outpost_submit_candidate', { ...candidate, name: 'cursor', company: 'ANYSPHERE' })
    expect(repo.getProduct(product.id)!.status).toBe('tracking')
    expect(repo.listCandidates(track.id)[0]!.productId).toBe(product.id)
  })

  it('returns before the icon arrives, then records the icon when it does', async () => {
    let release!: (path: string | null) => void
    icons.fetch.mockImplementation(() => new Promise<string | null>(resolve => { release = resolve }))
    const call = recommend()
    const r = await call('outpost_submit_candidate', candidate) // would hang here if the tool waited for the icon
    const productId = repo.listCandidates(track.id)[0]!.productId
    expect(r).toMatchObject({ candidateId: expect.any(String) })
    expect(repo.getProduct(productId)!.iconPath).toBeNull()
    expect(icons.fetch).toHaveBeenCalledWith(productId, ['https://cdn.example/windsurf.png', 'https://www.windsurf.com/favicon.ico', 'https://www.windsurf.com/apple-touch-icon.png'])
    release('/data/icons/windsurf.png')
    await vi.waitFor(() => expect(repo.getProduct(productId)!.iconPath).toBe('/data/icons/windsurf.png'))
  })

  it('keeps going when the icon cannot be fetched', async () => {
    const call = recommend()
    icons.fetch.mockImplementationOnce(async () => null)
    icons.fetch.mockImplementationOnce(async () => { throw new Error('boom') })
    icons.fetch.mockImplementationOnce(() => { throw new Error('sync boom') })
    for (const name of ['A', 'B', 'C']) expect(await call('outpost_submit_candidate', { ...candidate, name, company: name })).toMatchObject({ candidateId: expect.any(String) })
    await vi.waitFor(() => expect(icons.fetch).toHaveBeenCalledTimes(3))
    await new Promise(resolve => setTimeout(resolve, 0)) // let a rejected fetch surface, were it left unhandled
    expect(repo.listCandidates(track.id).map(c => repo.getProduct(c.productId)!.iconPath)).toEqual([null, null, null])
  })

  it('does not ask for an icon when there is nowhere to look', async () => {
    const call = recommend()
    const { iconUrl: _icon, officialUrl: _official, ...bare } = candidate
    await call('outpost_submit_candidate', bare)
    expect(icons.fetch).not.toHaveBeenCalled()
    expect(repo.getProduct(repo.listCandidates(track.id)[0]!.productId)!.officialDomains).toEqual([])
  })

  it('refuses to submit the same product twice in one batch', async () => {
    const call = recommend()
    await call('outpost_submit_candidate', candidate)
    const again = await call('outpost_submit_candidate', { ...candidate, name: ' windsurf ', tier: 'consider' })
    expect(again).toMatchObject({ error: expect.stringContaining('Windsurf') })
    expect(repo.listCandidates(track.id)).toHaveLength(1)
    const nextBatch = repo.createRun({ kind: 'recommend', date: '2026-11-25', trackId: track.id, productId: null })
    expect(await recommend({ runId: nextBatch.id })('outpost_submit_candidate', candidate)).toMatchObject({ candidateId: expect.any(String) })
  })

  it('enforces the length limits and needs at least one article', async () => {
    const call = recommend()
    const error = async (over: Record<string, unknown>) => ((await call('outpost_submit_candidate', { ...candidate, ...over })) as { error: string }).error
    expect(await error({ name: '长'.repeat(31) })).toContain('name')
    expect(await error({ company: '长'.repeat(31) })).toContain('company')
    expect(await error({ form: '长'.repeat(21) })).toContain('form')
    expect(await error({ oneLiner: '长'.repeat(41) })).toContain('oneLiner')
    expect(await error({ reason: '长'.repeat(61) })).toContain('reason')
    expect(await error({ articles: [] })).toContain('articles')
    expect(await error({ region: 'mars' })).toContain('region')
    expect(await error({ tier: 'must-have' })).toContain('tier')
    expect(await error({ officialUrl: 'windsurf.com' })).toContain('officialUrl')
    expect(await error({ articles: [{ url: 'news', title: 'x' }] })).toContain('articles[0].url')
    expect(repo.listCandidates(track.id)).toEqual([])
  })

  it('refuses when the run is not about a track', async () => {
    expect(await recommend({ trackId: null })('outpost_submit_candidate', candidate)).toMatchObject({ error: expect.stringContaining('赛道') })
  })
})

describe('outpost_read', () => {
  it('shows the dossier, the last 14 days of findings and the addresses already known', async () => {
    atDaysAgo(20, () => seedFinding({ headline: '二十天前的发现' }, { url: 'https://seed.example/ancient' }))
    atDaysAgo(3, () => seedFinding({ headline: '三天前的发现', status: 'verified', dedupeKey: 'three' }, { url: 'https://seed.example/known' }))
    seedFinding({ headline: '今天的发现', status: 'unconfirmed', dedupeKey: 'today' }, { url: 'https://www.seed.example/today/?utm_source=x' })
    const cardSource = repo.addSource({ url: 'https://cursor.com/pricing', title: '定价', publisher: 'Cursor', publishedAt: null, kind: 'official', isOfficial: true, quote: 'q', syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null })
    const twice = repo.addSource({ url: 'https://seed.example/known/', title: '同一页', publisher: 'x', publishedAt: null, kind: 'media', isOfficial: false, quote: 'q', syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null })
    repo.addCardVersion({ productId: product.id, dimension: 'pricing', version: 1, summary: '旧摘要', bullets: ['旧'], body: '旧[1]', sourceIds: [cardSource.id, twice.id], inferenceSpans: [], addedSpans: [], changeNote: '', findingIds: [], createdAt: time.toISOString() })
    repo.addCardVersion({ productId: product.id, dimension: 'pricing', version: 2, summary: '新摘要', bullets: ['新一', '新二'], body: '新[1]', sourceIds: [cardSource.id, twice.id], inferenceSpans: [], addedSpans: [], changeNote: '', findingIds: [], createdAt: time.toISOString() })
    repo.addFacts({ productId: product.id, ...facts })
    const other = repo.upsertProduct({ name: 'Zed', company: 'Zed Industries', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
    seedFinding({ productId: other.id, headline: '别的产品', dedupeKey: 'other' }, { url: 'https://seed.example/other' })

    const r = await toolbox('daily')('outpost_read') as Record<string, unknown>
    expect(r.product).toEqual({ name: 'Cursor', company: 'Anysphere', region: 'overseas', form: 'IDE', officialDomains: ['cursor.com'] })
    expect(r.dimensions).toEqual([{ key: 'positioning', label: '定位' }, { key: 'pricing', label: '价格' }])
    expect(r.facts).toEqual(facts)
    expect(r.cards).toEqual([{
      dimension: 'pricing', summary: '新摘要', bullets: ['新一', '新二'], body: '新[1]',
      sources: [ // in citation order, with what a proposed edit needs to cite them again
        { url: 'https://cursor.com/pricing', title: '定价', publisher: 'Cursor', publishedAt: null, kind: 'official', isOfficial: true, quote: 'q' },
        { url: 'https://seed.example/known/', title: '同一页', publisher: 'x', publishedAt: null, kind: 'media', isOfficial: false, quote: 'q' },
      ],
    }])
    expect(r.recentFindings).toEqual([
      { headline: '今天的发现', status: 'unconfirmed', createdAt: time.toISOString() },
      { headline: '三天前的发现', status: 'verified', createdAt: new Date(time.getTime() - 3 * DAY_MS).toISOString() },
    ])
    expect(r.knownUrls).toEqual(['https://www.seed.example/today/?utm_source=x', 'https://seed.example/known', 'https://cursor.com/pricing'])
  })

  it('has nothing to show for a product with no history yet', async () => {
    const r = await toolbox('baseline')('outpost_read') as Record<string, unknown>
    expect(r).toMatchObject({ facts: null, cards: [], recentFindings: [], knownUrls: [] })
  })

  it('is all a follow-up conversation gets, and it works there', async () => {
    seedFinding({ headline: '被追问的发现' })
    const r = await toolbox('followup')('outpost_read', {}) as { recentFindings: { headline: string }[] }
    expect(r.recentFindings.map(f => f.headline)).toEqual(['被追问的发现'])
  })

  it('refuses when the run is not about one product', async () => {
    expect(await toolbox('followup', { productId: null })('outpost_read')).toMatchObject({ error: expect.stringContaining('产品') })
  })
})

describe('verification tools', () => {
  it('outpost_read_pending lists what waits for a check, and nothing else', async () => {
    const pending = seedFinding({ headline: '待核查的发现', claimKind: 'self', why: '官方说了' }, { url: 'https://seed.example/p', quote: '待核引句' })
    const unconfirmed = seedFinding({ headline: '待确认的发现', status: 'unconfirmed', claimKind: 'third-party' }, { url: 'https://seed.example/u' })
    seedFinding({ headline: '已核实', status: 'verified' }, { url: 'https://seed.example/v' })
    seedFinding({ headline: '已撤回', status: 'withdrawn' }, { url: 'https://seed.example/w' })
    seedFinding({ headline: '未证实', status: 'unproven' }, { url: 'https://seed.example/x' })
    const other = repo.upsertProduct({ name: 'Zed', company: 'Zed Industries', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
    seedFinding({ productId: other.id, headline: '别的产品的待核查' }, { url: 'https://seed.example/o' })
    const editSource = repo.addSource({ url: 'https://cursor.com/pricing', title: '定价页', publisher: 'Cursor', publishedAt: null, kind: 'official', isOfficial: true, quote: '卡片引句', syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null })
    const edit = repo.addCardEdit({ productId: product.id, dimension: 'pricing', summary: '卡片摘要', bullets: ['要点'], body: '卡片正文[1]', sourceIds: [editSource.id], inferenceSpans: [], changeNote: '建档', findingIds: [] })
    const appliedEdit = repo.addCardEdit({ productId: product.id, dimension: 'positioning', summary: '已处理', bullets: ['要点'], body: '正文', sourceIds: [], inferenceSpans: [], changeNote: '建档', findingIds: [] })
    repo.setCardEditStatus(appliedEdit.id, 'applied')

    const r = await toolbox('verify')('outpost_read_pending') as Record<string, unknown[]>
    expect(r.pendingFindings).toEqual([{ itemId: pending.finding.id, claimKind: 'self', claim: '待核查的发现', detail: '官方说了', sources: [{ sourceId: pending.source.id, url: 'https://seed.example/p', quote: '待核引句' }] }])
    expect(r.unconfirmedFindings).toEqual([{ itemId: unconfirmed.finding.id, claimKind: 'third-party', claim: '待确认的发现', detail: '旧', sources: [{ sourceId: unconfirmed.source.id, url: 'https://seed.example/u', quote: '原话' }] }])
    expect(r.pendingCardEdits).toEqual([{ itemId: edit.id, claimKind: null, dimension: 'pricing', claim: '卡片摘要', detail: '卡片正文[1]', sources: [{ sourceId: editSource.id, url: 'https://cursor.com/pricing', quote: '卡片引句' }] }])
  })

  it('outpost_report_check records what the checker saw on the source', async () => {
    const { source: s } = seedFinding()
    const call = toolbox('verify')
    expect(await call('outpost_report_check', { sourceId: s.id, openedVia: 'browser', quoteFound: true, supportsClaim: true })).toEqual({ ok: true })
    expect(repo.getSources([s.id])[0]).toMatchObject({ openedVia: 'browser', quoteFound: true, supportsClaim: true, syndicationGroup: null })
    expect(await call('outpost_report_check', { sourceId: s.id, openedVia: 'unopened', quoteFound: null, supportsClaim: null })).toEqual({ ok: true })
    expect(repo.getSources([s.id])[0]).toMatchObject({ openedVia: 'unopened', quoteFound: null, supportsClaim: null })
  })

  it('outpost_report_check records a source that could not be opened as unverified, whatever the agent claims about it', async () => {
    const { source: s } = seedFinding()
    const call = toolbox('verify')
    const r = await call('outpost_report_check', { sourceId: s.id, openedVia: 'unopened', quoteFound: true, supportsClaim: true })
    expect(r).toEqual({ ok: true, note: 'openedVia=unopened：quoteFound/supportsClaim 按未知记录' })
    expect(repo.getSources([s.id])[0]).toMatchObject({ openedVia: 'unopened', quoteFound: null, supportsClaim: null })
    // Even a "not found" cannot come from a page nobody saw.
    const again = await call('outpost_report_check', { sourceId: s.id, openedVia: 'unopened', quoteFound: false, supportsClaim: false })
    expect(again).toMatchObject({ ok: true, note: expect.stringContaining('unopened') })
    expect(repo.getSources([s.id])[0]).toMatchObject({ openedVia: 'unopened', quoteFound: null, supportsClaim: null })
    // A page that was opened (or a search snippet) keeps what the agent saw.
    await call('outpost_report_check', { sourceId: s.id, openedVia: 'snippet', quoteFound: true, supportsClaim: true })
    expect(repo.getSources([s.id])[0]).toMatchObject({ openedVia: 'snippet', quoteFound: true, supportsClaim: true })
  })

  it('outpost_report_check files reposts of one press release under one group, however the address is spelled', async () => {
    const original = seedFinding({}, { url: 'https://www.official.example/pr/2026/?utm_source=x' })
    const repost = seedFinding({ dedupeKey: 'b' }, { url: 'https://36kr.example/p/1' })
    const call = toolbox('verify')
    await call('outpost_report_check', { sourceId: repost.source.id, openedVia: 'http', quoteFound: true, supportsClaim: true, syndicationGroup: 'https://www.official.example/pr/2026/?utm_source=weibo' })
    await call('outpost_report_check', { sourceId: original.source.id, openedVia: 'http', quoteFound: true, supportsClaim: true })
    const group = repo.getSources([repost.source.id])[0]!.syndicationGroup
    expect(group).toBe('official.example/pr/2026') // the shape `judge` compares: the canonical address of the original
    await call('outpost_report_check', { sourceId: repost.source.id, openedVia: 'http', quoteFound: true, supportsClaim: true, syndicationGroup: '' })
    expect(repo.getSources([repost.source.id])[0]!.syndicationGroup).toBe(group) // an empty group is no news
  })

  it('outpost_report_check rejects a source that is not waiting for a check on this product', async () => {
    const other = repo.upsertProduct({ name: 'Zed', company: 'Zed Industries', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
    const foreign = seedFinding({ productId: other.id })
    const settled = seedFinding({ status: 'verified', dedupeKey: 'v' })
    const call = toolbox('verify')
    for (const sourceId of [foreign.source.id, settled.source.id, 'no-such-source']) {
      const r = await call('outpost_report_check', { sourceId, openedVia: 'http', quoteFound: false, supportsClaim: false })
      expect(r, sourceId).toMatchObject({ error: expect.stringContaining('sourceId') })
    }
    expect(repo.getSources([foreign.source.id, settled.source.id]).map(s => s.quoteFound)).toEqual([null, null])
  })

  it('outpost_report_check names the field when the report is malformed', async () => {
    const { source: s } = seedFinding()
    const call = toolbox('verify')
    expect(await call('outpost_report_check', { sourceId: s.id, openedVia: 'telepathy', quoteFound: true, supportsClaim: true })).toMatchObject({ error: expect.stringContaining('openedVia') })
    expect(await call('outpost_report_check', { sourceId: s.id, openedVia: 'http', quoteFound: 'yes', supportsClaim: true })).toMatchObject({ error: expect.stringContaining('quoteFound') })
    expect(await call('outpost_report_check', { sourceId: s.id, openedVia: 'http', quoteFound: true })).toMatchObject({ error: expect.stringContaining('supportsClaim') })
    expect(repo.getSources([s.id])[0]!.openedVia).toBeNull()
  })

  it('outpost_add_source attaches a corroborating source to the finding, ready to be checked', async () => {
    const { finding: f } = seedFinding({ status: 'unconfirmed' })
    const call = toolbox('verify')
    const r = await call('outpost_add_source', { itemId: f.id, source: source({ url: 'https://other.example/story', publishedAt: '2026年11月23日', kind: 'media', isOfficial: false }) })
    const added = repo.findingsOfProduct(product.id)[0]!.sourceIds.at(-1)!
    expect(r).toEqual({ sourceId: added, remaining: 2 })
    expect(repo.findingsOfProduct(product.id)[0]!.sourceIds).toHaveLength(2)
    expect(repo.getSources([added])[0]).toMatchObject({ url: 'https://other.example/story', publishedAt: '2026-11-23', kind: 'media', isOfficial: false, openedVia: null, quoteFound: null, supportsClaim: null, syndicationGroup: null })
    const pending = await call('outpost_read_pending') as { unconfirmedFindings: { sources: { sourceId: string }[] }[] }
    expect(pending.unconfirmedFindings[0]!.sources.map(s => s.sourceId)).toContain(added)
    expect(await call('outpost_report_check', { sourceId: added, openedVia: 'http', quoteFound: true, supportsClaim: true })).toEqual({ ok: true }) // the new source can be reported on
  })

  it('limits outpost_add_source to 3 per item', async () => {
    const a = seedFinding({}, { url: 'https://seed.example/a' })
    const b = seedFinding({ dedupeKey: 'b' }, { url: 'https://seed.example/b' })
    const call = toolbox('verify')
    const add = (itemId: string, n: number) => call('outpost_add_source', { itemId, source: source({ url: `https://other.example/${itemId.slice(0, 4)}/${n}` }) })
    for (const n of [1, 2, 3]) expect(await add(a.finding.id, n)).toMatchObject({ sourceId: expect.any(String) })
    const fourth = await add(a.finding.id, 4)
    expect(fourth).toMatchObject({ error: expect.stringContaining('3') })
    expect(repo.findingsOfProduct(product.id).find(f => f.id === a.finding.id)!.sourceIds).toHaveLength(4) // its own plus three
    expect(await add(b.finding.id, 1)).toMatchObject({ remaining: 2 }) // the allowance is per item
  })

  it('does not count a rejected source against the allowance', async () => {
    const { finding: f } = seedFinding()
    const call = toolbox('verify')
    for (let i = 0; i < 5; i++) expect(await call('outpost_add_source', { itemId: f.id, source: source({ url: 'not a url' }) })).toMatchObject({ error: expect.stringContaining('source.url') })
    expect(await call('outpost_add_source', { itemId: f.id, source: source() })).toMatchObject({ remaining: 2 })
  })

  it('outpost_add_source accepts only findings that wait for a check on this product', async () => {
    const edit = repo.addCardEdit({ productId: product.id, dimension: 'pricing', summary: 's', bullets: ['b'], body: 'b', sourceIds: [], inferenceSpans: [], changeNote: '建档', findingIds: [] })
    const settled = seedFinding({ status: 'verified' })
    const other = repo.upsertProduct({ name: 'Zed', company: 'Zed Industries', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
    const foreign = seedFinding({ productId: other.id, dedupeKey: 'f' })
    const call = toolbox('verify')
    const cardEdit = await call('outpost_add_source', { itemId: edit.id, source: source() })
    expect(cardEdit).toMatchObject({ error: expect.stringContaining('卡片') })
    for (const itemId of [settled.finding.id, foreign.finding.id, 'no-such-item'])
      expect(await call('outpost_add_source', { itemId, source: source() }), itemId).toMatchObject({ error: expect.stringContaining('itemId') })
    expect(repo.findingsOfProduct(product.id).find(f => f.id === settled.finding.id)!.sourceIds).toHaveLength(1)
    expect(repo.findingsOfProduct(other.id)[0]!.sourceIds).toHaveLength(1)
  })
})

describe('optional fields sent as null', () => {
  // Models often spell "I have nothing for this field" as an explicit null.
  it('takes a null publish date of a source as no date', async () => {
    const r = await toolbox('daily')('outpost_submit_finding', { ...finding, sources: [source({ publishedAt: null })] })
    expect(r).toMatchObject({ findingId: expect.any(String) })
    expect(repo.getSources(repo.findingsOfProduct(product.id)[0]!.sourceIds)[0]).toMatchObject({ url: 'https://cursor.com/changelog/1-2', publishedAt: null })

    const { finding: f } = seedFinding({ dedupeKey: 'other' })
    const added = await toolbox('verify')('outpost_add_source', { itemId: f.id, source: source({ url: 'https://other.example/story', publishedAt: null }) })
    expect(repo.getSources([idOf(added, 'sourceId')])[0]).toMatchObject({ url: 'https://other.example/story', publishedAt: null })
  })

  it('takes null inference quotes of a card as none', async () => {
    const r = await toolbox('baseline')('outpost_submit_card', { ...card, inferenceQuotes: null })
    expect(repo.pendingCardEdits(product.id).find(e => e.id === idOf(r, 'cardEditId'))!.inferenceSpans).toEqual([])
  })

  it('takes a null official site, icon and article date of a candidate as unknown', async () => {
    const call = toolbox('recommend', { productId: null })
    const r = await call('outpost_submit_candidate', { ...candidate, officialUrl: null, iconUrl: null, articles: [{ url: 'https://news.example/a', title: '报道一', publishedAt: null }] })
    const [c] = repo.listCandidates(track.id, run.id)
    expect(c!.id).toBe(idOf(r, 'candidateId'))
    expect(c!.heat).toMatchObject({ foundCount: 1, datedWeekly: [0, 0, 0, 0, 0] })
    expect(repo.getProduct(c!.productId)).toMatchObject({ name: 'Windsurf', officialDomains: [] })
    await Promise.resolve()
    expect(icons.fetch).not.toHaveBeenCalled()
  })

  it('takes a null repost group as none, while quoteFound and supportsClaim keep their own null', async () => {
    const { source: s } = seedFinding()
    const call = toolbox('verify')
    expect(await call('outpost_report_check', { sourceId: s.id, openedVia: 'http', quoteFound: null, supportsClaim: true, syndicationGroup: null })).toEqual({ ok: true })
    expect(repo.getSources([s.id])[0]).toMatchObject({ openedVia: 'http', quoteFound: null, supportsClaim: true, syndicationGroup: null })
    // quoteFound and supportsClaim may be null, but not left out.
    expect(await call('outpost_report_check', { sourceId: s.id, openedVia: 'http', supportsClaim: true })).toMatchObject({ error: expect.stringContaining('quoteFound') })
  })
})

describe('outpost_done', () => {
  it('reports the summary to the run', async () => {
    const call = toolbox('daily')
    expect(await call('outpost_done', { summary: '无新动态' })).toEqual({ ok: true })
    expect(done).toEqual(['无新动态'])
  })

  it('is there for every kind of run that does work, and rejects a summary over 100 characters', async () => {
    for (const kind of ['recommend', 'baseline', 'daily', 'verify'] as const) {
      const r = await toolbox(kind)('outpost_done', { summary: '长'.repeat(101) })
      expect(r, kind).toMatchObject({ error: expect.stringContaining('summary') })
    }
    expect(await toolbox('verify')('outpost_done', { summary: '长'.repeat(100) })).toEqual({ ok: true })
    expect(await toolbox('verify')('outpost_done', {})).toMatchObject({ error: expect.stringContaining('summary') })
    expect(done).toEqual(['长'.repeat(100)])
  })
})
