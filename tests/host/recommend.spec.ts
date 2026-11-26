import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { CandidateTier, ProductStatus, Track } from '../../src/core/types.ts'
import { startRecommendation } from '../../src/host/jobs/recommend.ts'
import { JobRunner, type JobDeps, type RuntimeSettings } from '../../src/host/jobs/runner.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, completed, gate, instantClock } from '../fixtures/fake-driver.ts'

let dir: string
let db: Db
let repo: Repo
let driver: FakeDriver
let runner: JobRunner
let deps: JobDeps
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-recommend-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  const { clock } = instantClock(new Date(2026, 10, 25, 9, 0, 0))
  repo = new Repo(db, () => clock.now())
  driver = new FakeDriver()
  const settings: RuntimeSettings = { maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, model: null, verifyModel: null, briefModel: null, followupModel: null, billingFor: () => 'metered', pricesOf: () => ({ inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }) }
  runner = new JobRunner({ repo, driver, clock, settings: () => settings, log: vi.fn() })
  deps = { repo, runner, clock, icons: { fetch: vi.fn(async () => null) } }
  track = repo.createTrack({ name: 'AI 编程助手', brief: '盯住能自己改代码的编程 Agent', dimensions: [...DEFAULT_DIMENSIONS, { key: 'custom-8bb05fc6', label: '记忆' }], status: 'picking' })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const candidate = (name: string, company: string, tier: CandidateTier, reason = '近一个月发布两次大更新') => ({
  name, company, region: 'overseas', form: 'IDE', oneLiner: `${name}：带 Agent 的编辑器`, tier, reason,
  officialUrl: `https://${name.toLowerCase()}.example/`, articles: [{ url: `https://news.example/${name}`, title: `${name} 发布新版本`, publishedAt: '2026-11-20' }],
})
const namesAndTiers = (batchId: string) => repo.listCandidates(track.id, batchId).map(c => [repo.getProduct(c.productId)!.name, c.tier])

describe('startRecommendation', () => {
  it('streams candidates into the batch as the agent submits them', async () => {
    const midway = gate()
    driver.script['outpost-recommend-'] = async r => {
      await r.call('outpost_submit_candidate', candidate('Cursor', 'Anysphere', 'strong'))
      await midway.promise
      await r.call('outpost_submit_candidate', candidate('Windsurf', 'Codeium', 'consider'))
      await r.call('outpost_submit_candidate', candidate('Tabby', 'TabbyML', 'excluded', '半年没有更新'))
      await r.done('强烈推荐 1 个、可以考虑 1 个、没推荐 1 个')
      return completed()
    }

    const batchId = await startRecommendation(deps, track.id)

    // It answered before the agent finished: the first candidate shows while the session still runs.
    await vi.waitFor(() => expect(namesAndTiers(batchId)).toEqual([['Cursor', 'strong']]))
    expect(repo.getRun(batchId)).toMatchObject({ kind: 'recommend', trackId: track.id, status: 'running' })
    expect(repo.latestBatchId(track.id)).toBe(batchId)

    midway.open()
    await runner.idle()

    expect(namesAndTiers(batchId)).toEqual([['Cursor', 'strong'], ['Windsurf', 'consider'], ['Tabby', 'excluded']])
    expect(repo.listCandidates(track.id, batchId).map(c => c.selected)).toEqual([true, false, false])
    expect(repo.getRun(batchId)).toMatchObject({ status: 'done', error: null })
    expect(driver.runs).toHaveLength(1)
    expect(driver.runs[0]!.title).toBe('前哨 · 推荐 AI 编程助手')
    expect(driver.runs[0]!.tools.map(t => t.name)).toEqual(['outpost_submit_candidate', 'outpost_done'])
  })

  it('passes the refine text and previous candidates into the prompt', async () => {
    // An earlier batch, and a product the track already follows.
    const earlier = repo.createRun({ kind: 'recommend', date: '2026-11-25', trackId: track.id, productId: null })
    const add = (name: string, company: string, tier: CandidateTier, reason: string) => {
      const product = repo.upsertProduct({ name, company, region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status: 'candidate', dailyBudgetYuan: null })
      repo.addCandidate({ trackId: track.id, batchId: earlier.id, productId: product.id, tier, oneLiner: '编辑器', reason, heat: { foundCount: 1, datedWeekly: [], trend: 'unknown', showBars: false }, selected: tier === 'strong' })
    }
    add('Cursor', 'Anysphere', 'strong', '更新最勤')
    add('Windsurf', 'Codeium', 'consider', '贴合度一般')
    add('Tabby', 'TabbyML', 'excluded', '半年没有更新')
    const followed = repo.upsertProduct({ name: 'Cline', company: 'Cline Bot', region: 'overseas', form: 'VS Code 插件', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
    repo.linkProduct(track.id, followed.id)

    const batchId = await startRecommendation(deps, track.id, '多找些国内的')
    await runner.idle()

    expect(batchId).not.toBe(earlier.id)
    const prompt = driver.runs[0]!.prompt
    expect(prompt).toContain('多找些国内的')
    expect(prompt).toContain('- Cursor（Anysphere）：强烈推荐。更新最勤')
    expect(prompt).toContain('- Windsurf（Codeium）：可以考虑。贴合度一般')
    expect(prompt).toContain('- Tabby（TabbyML）：没推荐。半年没有更新')
    expect(prompt).toContain('Cline')
    expect(prompt).toContain('AI 编程助手')
    expect(prompt).toContain('盯住能自己改代码的编程 Agent')
    for (const label of ['定位', '目标人群', '价值场景', '体验', '关键技术', '商业化', '记忆']) expect(prompt).toContain(label)
    expect(prompt).toContain('2026-11-25')
    expect(prompt).not.toMatch(/\{\{|\}\}/)

    // A first recommendation, with no request: the prompt says there is neither.
    const fresh = repo.createTrack({ name: '端侧 Agent', brief: '手机上的 Agent', dimensions: DEFAULT_DIMENSIONS, status: 'picking' })
    await startRecommendation(deps, fresh.id)
    await runner.idle()
    const first = driver.runs[1]!.prompt
    expect(first).toContain('端侧 Agent')
    expect(first).not.toContain('Cursor')
    expect(first).not.toContain('多找些国内的')
    expect(first).toContain('第一次推荐')
  })

  it('tells the agent the products tracked in other tracks with their spelling', async () => {
    const add = (name: string, company: string, status: ProductStatus) =>
      repo.upsertProduct({ name, company, region: 'domestic', form: 'App', iconPath: null, officialDomains: [], status, dailyBudgetYuan: null })
    const elsewhere = repo.createTrack({ name: '大模型助手', brief: '', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
    const both = add('千问Go!', '阿里巴巴', 'tracking') // in this track too
    for (const p of [both, add('阶跃 Amoo', '阶跃星辰', 'baselining'), add('Muse', 'Meta', 'paused'), add('Tabby', 'TabbyML', 'candidate'), add('Old', 'Gone Inc', 'archived')])
      repo.linkProduct(elsewhere.id, p.id)
    repo.linkProduct(track.id, both.id)
    repo.linkProduct(track.id, add('Cline', 'Cline Bot', 'tracking').id) // tracked here only

    await startRecommendation(deps, track.id)
    await runner.idle()

    const prompt = driver.runs[0]!.prompt
    const line = prompt.split('\n').find(l => l.includes('别的赛道已在跟踪的产品'))!
    expect(line).toContain('阶跃 Amoo（阶跃星辰）、Muse（Meta）') // the spelling as kept, joined by 、, in the order they were linked
    expect(line).not.toContain('千问Go!') // already in this track
    for (const left of ['Tabby', 'Old', 'Cline']) expect(line).not.toContain(left)
    expect(prompt).toContain('已经在跟踪、不用再提交的产品：')
    expect(prompt).not.toMatch(/\{\{|\}\}/)

    // Once the other track follows only products of this one, there is nothing to say.
    for (const id of ['阶跃 Amoo', 'Muse']) repo.setProductStatus(repo.productsOfTrack(elsewhere.id).find(p => p.name === id)!.id, 'archived')
    await startRecommendation(deps, track.id)
    await runner.idle()
    expect(driver.runs[1]!.prompt).toContain('别的赛道已在跟踪的产品：（没有）')
  })

  it('throws for a track that does not exist, without starting anything', async () => {
    await expect(startRecommendation(deps, 'no-such-track')).rejects.toThrow('no-such-track')
    expect(repo.listRuns('')).toHaveLength(0)
  })
})
