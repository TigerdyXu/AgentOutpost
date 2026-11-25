import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { Id, Product, Track } from '../../src/core/types.ts'
import { startBaseline, type BaselineDeps } from '../../src/host/jobs/baseline.ts'
import { JobRunner, type RuntimeSettings } from '../../src/host/jobs/runner.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, completed, failure, gate, instantClock } from '../fixtures/fake-driver.ts'

const TODAY = '2026-11-25'
const MEMORY = { key: 'custom-8bb05fc6', label: '记忆' }

let dir: string
let db: Db
let repo: Repo
let driver: FakeDriver
let runner: JobRunner
let log: ReturnType<typeof vi.fn<(message: string) => void>>
let verifyProduct: ReturnType<typeof vi.fn<BaselineDeps['verifyProduct']>>
let deps: BaselineDeps
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-baseline-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  const { clock } = instantClock(new Date(2026, 10, 25, 9, 0, 0))
  repo = new Repo(db, () => clock.now())
  driver = new FakeDriver()
  const settings: RuntimeSettings = { maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, prices: { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }, model: null }
  log = vi.fn<(message: string) => void>()
  runner = new JobRunner({ repo, driver, clock, settings: () => settings, log })
  verifyProduct = vi.fn<BaselineDeps['verifyProduct']>(async () => {})
  deps = { repo, runner, clock, icons: { fetch: vi.fn(async () => null) }, verifyProduct }
  track = repo.createTrack({ name: 'AI 编程助手', brief: '盯住编程类 Agent', dimensions: [...DEFAULT_DIMENSIONS, MEMORY], status: 'active' })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const addProduct = (name: string, company: string): Product => {
  const product = repo.upsertProduct({ name, company, region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [`${name.toLowerCase()}.com`], status: 'candidate', dailyBudgetYuan: null })
  repo.linkProduct(track.id, product.id)
  return product
}
const card = (dimension: string) => ({
  dimension, summary: '面向专业开发者的 AI 编辑器', bullets: ['基于 VS Code', '主打 Agent 模式'], body: 'Cursor 是基于 VS Code 的编辑器[1]。',
  sources: [{ url: 'https://cursor.com/', title: 'Cursor 官网', publisher: 'Cursor', publishedAt: null, kind: 'official', isOfficial: true, quote: 'The AI Code Editor' }],
})
const statusOf = (id: Id) => repo.getProduct(id)!.status
const baselineRunOf = (productId: Id) => repo.runsOfDate(TODAY, 'baseline').find(r => r.productId === productId)

describe('startBaseline', () => {
  it('moves a product to tracking after its baseline is verified', async () => {
    const cursor = addProduct('Cursor', 'Anysphere')
    const events: string[] = []
    driver.script['outpost-baseline-'] = async r => {
      events.push('session')
      await r.call('outpost_read')
      await r.call('outpost_submit_card', card('positioning'))
      await r.done()
      return completed()
    }
    const verifying = gate()
    verifyProduct.mockImplementation(async (_id, scope) => { events.push(`verify ${scope}`); await verifying.promise })

    const returned = startBaseline(deps, [cursor.id])

    expect(returned).toBeUndefined() // it does not wait for the sessions
    expect(statusOf(cursor.id)).toBe('baselining') // 建档中 at once
    await vi.waitFor(() => expect(verifyProduct).toHaveBeenCalledWith(cursor.id, 'baseline'))
    expect(statusOf(cursor.id)).toBe('baselining') // not before verification ends

    verifying.open()
    await runner.idle()

    expect(events).toEqual(['session', 'verify baseline'])
    expect(statusOf(cursor.id)).toBe('tracking')
    const run = baselineRunOf(cursor.id)!
    expect(run).toMatchObject({ status: 'done', sessionId: `outpost-baseline-${run.id.slice(0, 8)}` })
    expect(driver.runs[0]!.title).toBe('前哨 · Cursor 建档')
    expect(driver.runs[0]!.tools.map(t => t.name)).toEqual(['outpost_read', 'outpost_submit_card', 'outpost_submit_facts', 'outpost_done'])
    expect(repo.pendingCardEdits(cursor.id).map(e => e.dimension)).toEqual(['positioning'])
  })

  it('isolates a failed product from the others', async () => {
    const cursor = addProduct('Cursor', 'Anysphere') // its session fails
    const windsurf = addProduct('Windsurf', 'Codeium') // goes through
    const cline = addProduct('Cline', 'Cline Bot') // its verification fails
    driver.script['outpost-baseline-'] = async r => {
      if (r.spec.title.includes('Cursor')) return failure('模型返回了无法解析的内容')
      await r.done()
      return completed()
    }
    verifyProduct.mockImplementation(async id => { if (id === cline.id) throw new Error('核查会话打不开') })

    startBaseline(deps, [cursor.id, windsurf.id, cline.id])
    await runner.idle()

    expect(statusOf(cursor.id)).toBe('baselining')
    expect(statusOf(windsurf.id)).toBe('tracking')
    expect(statusOf(cline.id)).toBe('baselining')
    expect(baselineRunOf(cursor.id)).toMatchObject({ status: 'failed', error: '模型返回了无法解析的内容' })
    expect(baselineRunOf(windsurf.id)).toMatchObject({ status: 'done', error: null })
    expect(baselineRunOf(cline.id)!.status).toBe('failed')
    expect(baselineRunOf(cline.id)!.error).toContain('核查会话打不开')
    expect(verifyProduct.mock.calls.map(([id]) => id).sort()).toEqual([windsurf.id, cline.id].sort())
    expect(log).toHaveBeenCalled()
  })

  it('lists every dimension of the product by key and label in the prompt', async () => {
    const cursor = addProduct('Cursor', 'Anysphere')
    startBaseline(deps, [cursor.id])
    await runner.idle()

    const prompt = driver.runs[0]!.prompt
    for (const { key, label } of [...DEFAULT_DIMENSIONS, MEMORY]) expect(prompt).toContain(`- ${key}：${label}`)
    expect(prompt).toContain('Cursor（Anysphere）')
    expect(prompt).toContain('cursor.com')
    expect(prompt).not.toMatch(/\{\{|\}\}/)
  })

  it('asks only for dimensions that have no card yet', async () => {
    const cursor = addProduct('Cursor', 'Anysphere')
    // Version 1 of 定位 is in the dossier, and 体验 waits for its check: only the rest are asked for.
    repo.addCardVersion({ productId: cursor.id, dimension: 'positioning', version: 1, summary: '编辑器', bullets: ['基于 VS Code'], body: '编辑器[1]', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-20T00:00:00.000Z' })
    repo.addCardEdit({ productId: cursor.id, dimension: 'experience', summary: '上手快', bullets: ['上手快'], body: '上手快[1]', sourceIds: [], inferenceSpans: [], changeNote: '建档', findingIds: [] })

    startBaseline(deps, [cursor.id])
    await runner.idle()

    const prompt = driver.runs[0]!.prompt
    expect(prompt).not.toContain('- positioning：')
    expect(prompt).not.toContain('- experience：')
    for (const key of ['audience', 'scenarios', 'technology', 'business', MEMORY.key]) expect(prompt).toContain(`- ${key}：`)
    expect(baselineRunOf(cursor.id)!.progress).toEqual({ done: 0, total: 5 })
  })

  it('verifies without a session when every dimension already has a card', async () => {
    const cursor = addProduct('Cursor', 'Anysphere')
    for (const { key } of [...DEFAULT_DIMENSIONS, MEMORY])
      repo.addCardEdit({ productId: cursor.id, dimension: key, summary: '已写', bullets: ['已写'], body: '已写[1]', sourceIds: [], inferenceSpans: [], changeNote: '建档', findingIds: [] })

    startBaseline(deps, [cursor.id])
    await runner.idle()

    expect(driver.runs).toHaveLength(0)
    expect(verifyProduct).toHaveBeenCalledWith(cursor.id, 'baseline')
    expect(statusOf(cursor.id)).toBe('tracking')
  })

  it('counts the cards handed in as progress', async () => {
    const cursor = addProduct('Cursor', 'Anysphere')
    const progress: unknown[] = []
    driver.script['outpost-baseline-'] = async r => {
      const runId = baselineRunOf(cursor.id)!.id
      progress.push(repo.getRun(runId)!.progress)
      await r.call('outpost_submit_card', card('positioning'))
      progress.push(repo.getRun(runId)!.progress)
      await r.call('outpost_submit_card', card('no-such-dimension')) // refused: does not count
      await r.call('outpost_submit_card', card('positioning')) // a second try at the same one: still one
      await r.call('outpost_submit_card', card('audience'))
      progress.push(repo.getRun(runId)!.progress)
      await r.done()
      return completed()
    }

    startBaseline(deps, [cursor.id])
    await runner.idle()

    expect(progress).toEqual([{ done: 0, total: 7 }, { done: 1, total: 7 }, { done: 2, total: 7 }])
    expect(baselineRunOf(cursor.id)!.progress).toEqual({ done: 2, total: 7 })
  })
})
