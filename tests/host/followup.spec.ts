import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSettings } from '../../src/core/models.ts'
import type { Finding, Source } from '../../src/core/types.ts'
import { startFollowup, type FollowupDeps } from '../../src/host/followup.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, instantClock } from '../fixtures/fake-driver.ts'

const TODAY = '2026-11-25'

let dir: string
let db: Db
let repo: Repo
let driver: FakeDriver
let deps: FollowupDeps
let models: ModelSettings
let finding: Finding
let official: Source

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-followup-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  const { clock } = instantClock(new Date(2026, 10, 25, 9, 30, 0))
  repo = new Repo(db, () => clock.now())
  driver = new FakeDriver()
  models = { model: null, verifyModel: null, briefModel: null, followupModel: null }
  deps = { repo, driver, clock, icons: { fetch: vi.fn(async () => null) }, settings: () => models }
  const track = repo.createTrack({ name: 'AI 编程助手', brief: '盯住编程类 Agent', dimensions: [{ key: 'positioning', label: '定位' }, { key: 'business', label: '商业化' }], status: 'active' })
  repo.upsertProduct({ id: 'p1', name: 'Cursor', company: 'Anysphere', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: ['cursor.com'], status: 'tracking', dailyBudgetYuan: null })
  repo.linkProduct(track.id, 'p1')
  official = repo.addSource({ url: 'https://cursor.com/changelog/2-1', title: 'Cursor 2.1 更新日志', publisher: 'Cursor', publishedAt: '2026-11-24', kind: 'official', isOfficial: true, quote: 'Background agents are now generally available', syndicationGroup: null, openedVia: 'http', quoteFound: true, supportsClaim: true, officialConfirmed: true })
  const media = repo.addSource({ url: 'https://36kr.com/p/1', title: 'Cursor 后台 Agent 上线', publisher: '36氪', publishedAt: null, kind: 'media', isOfficial: false, quote: '开发者可以把任务交给后台 Agent', syndicationGroup: null, openedVia: 'http', quoteFound: true, supportsClaim: true, officialConfirmed: false })
  const run = repo.createRun({ kind: 'daily', date: TODAY, trackId: null, productId: 'p1' })
  finding = repo.addFinding({
    productId: 'p1', runId: run.id, headline: '后台 Agent 正式上线', why: '不用守着编辑器也能让 Agent 改代码', importance: 'major', claimKind: 'self',
    sourceIds: [official.id, media.id], status: 'verified', statusNote: null, unconfirmedUntil: null, dimensions: ['positioning'], inference: false,
    read: false, late: false, dedupeKey: 'k1', verifiedOn: TODAY,
  })
  repo.addCardVersion({ productId: 'p1', dimension: 'positioning', version: 1, summary: '面向专业开发者的 AI 编辑器', bullets: ['基于 VS Code', '主打 Agent 模式'], body: '正文不进首条消息[1]。', sourceIds: [official.id], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-20T00:00:00.000Z' })
  repo.addCardVersion({ productId: 'p1', dimension: 'business', version: 1, summary: '按席位订阅', bullets: ['个人版 20 美元/月'], body: '订阅制[1]。', sourceIds: [official.id], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-20T00:00:00.000Z' })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('startFollowup', () => {
  it('opens a followup session titled 追问 · <产品> <标题> with only outpost_read', async () => {
    const { sessionId } = await startFollowup(deps, finding.id)

    expect(sessionId).toMatch(/^outpost-followup-[0-9a-f-]{8}$/)
    expect(driver.interactive).toHaveLength(1)
    const spec = driver.interactive[0]!
    expect(spec.sessionId).toBe(sessionId)
    expect(spec.title).toBe('追问 · Cursor 后台 Agent 正式上线')
    expect(spec.tools.map(t => t.name)).toEqual(['outpost_read'])
    expect(driver.runs).toEqual([]) // it does not wait for an answer

    // The tool reads this product's dossier.
    const read = await spec.tools[0]!.execute({}) as { product: { name: string }; cards: { dimension: string; body: string }[] }
    expect(read.product.name).toBe('Cursor')
    expect(read.cards.map(c => c.dimension)).toEqual(['positioning', 'business'])
  })

  it('opens the follow-up on the follow-up model, else the research model', async () => {
    const research = { provider: 'deepseek-official', model: 'deepseek-flash' }
    const claude = { provider: 'anthropic', model: 'claude-sonnet-4-5' }

    // Nothing chosen: DSH's default model (the session is opened without choosing one).
    await startFollowup(deps, finding.id)
    // Only the research model chosen: the follow-up takes it, not DSH's default (a local model may be too slow for a chat).
    models = { ...models, model: research, verifyModel: claude, briefModel: claude }
    await startFollowup(deps, finding.id)
    // A model of its own.
    models = { ...models, followupModel: claude }
    await startFollowup(deps, finding.id)

    expect(driver.interactive.map(spec => spec.model)).toEqual([null, research, claude])
  })

  it('puts the finding, its sources and every card\'s summary and bullets in the first message', async () => {
    await startFollowup(deps, finding.id)
    const prompt = driver.interactive[0]!.prompt

    for (const text of [
      'Cursor（Anysphere）', '后台 Agent 正式上线', '不用守着编辑器也能让 Agent 改代码', '已核实',
      'Cursor 2.1 更新日志', 'https://cursor.com/changelog/2-1', 'Background agents are now generally available', '官方',
      '36氪', '开发者可以把任务交给后台 Agent',
      '定位', '面向专业开发者的 AI 编辑器', '基于 VS Code', '主打 Agent 模式', '商业化', '按席位订阅', '个人版 20 美元/月',
    ]) expect(prompt, text).toContain(text)
    expect(prompt).not.toContain('正文不进首条消息') // the full text is one outpost_read away
    // What the agent is told: answer the user's questions, read the dossier when needed, cite, mark its own judgement.
    for (const rule of ['追问', 'outpost_read', '来源', '推论']) expect(prompt, rule).toContain(rule)
    expect(prompt).not.toMatch(/\{\{|\}\}/)
  })

  it('says when a finding is still 待确认, and when the product has no card yet', async () => {
    repo.updateFinding(finding.id, { status: 'unconfirmed', statusNote: '原文打不开', verifiedOn: null })
    const bare = repo.upsertProduct({ name: 'Windsurf', company: 'Codeium', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
    const run = repo.createRun({ kind: 'daily', date: TODAY, trackId: null, productId: bare.id })
    const other = repo.addFinding({ ...finding, productId: bare.id, runId: run.id, headline: 'Windsurf 降价', dedupeKey: 'k2' })

    await startFollowup(deps, finding.id)
    await startFollowup(deps, other.id)

    expect(driver.interactive[0]!.prompt).toContain('待确认（原文打不开）')
    expect(driver.interactive[1]!.prompt).toContain('还没有档案卡片')
    expect(driver.interactive[1]!.title).toBe('追问 · Windsurf Windsurf 降价')
  })

  it('records the session as a followup run, so its tool can be attached again after a restart', async () => {
    const { sessionId } = await startFollowup(deps, finding.id)

    const runs = repo.runsOfDate(TODAY, 'followup')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ kind: 'followup', productId: 'p1', sessionId, status: 'done', costYuan: 0, error: null })
    expect(sessionId).toBe(`outpost-followup-${runs[0]!.id.slice(0, 8)}`)
  })

  it('records the failure and rethrows when the session cannot be opened', async () => {
    driver.startInteractive = async () => { throw new Error('会话创建失败') }

    await expect(startFollowup(deps, finding.id)).rejects.toThrow('会话创建失败')
    expect(repo.runsOfDate(TODAY, 'followup')).toMatchObject([{ status: 'failed', error: '会话创建失败' }])
  })

  it('throws for an unknown finding, opening nothing', async () => {
    await expect(startFollowup(deps, 'nope')).rejects.toThrow('nope')
    expect(driver.interactive).toEqual([])
    expect(repo.runsOfDate(TODAY, 'followup')).toEqual([])
  })
})
