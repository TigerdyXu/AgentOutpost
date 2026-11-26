import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { CandidateTier, Id, Track } from '../../src/core/types.ts'
import { NOT_FOUND, SETTLE_FAILED, startIdentify, type IdentifyDeps } from '../../src/host/jobs/identify.ts'
import { startRecommendation } from '../../src/host/jobs/recommend.ts'
import { JobRunner, type RuntimeSettings } from '../../src/host/jobs/runner.ts'
import { researchTools } from '../../src/host/tools.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { FakeDriver, completed, failure, gate, instantClock, type Play } from '../fixtures/fake-driver.ts'

const IDENTIFY = 'outpost-identify-'

let dir: string
let db: Db
let repo: Repo
let driver: FakeDriver
let runner: JobRunner
let settings: RuntimeSettings
let scheduler: { baseline: ReturnType<typeof vi.fn<(ids: Id[]) => Promise<void>>>; topUpNow: ReturnType<typeof vi.fn<(ids: Id[]) => Promise<void>>> }
let deps: IdentifyDeps
let track: Track
let now: () => Date
let log: ReturnType<typeof vi.fn<(message: string) => void>>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-identify-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  const { clock } = instantClock(new Date(2026, 10, 26, 15, 0, 0))
  now = () => clock.now()
  repo = new Repo(db, now)
  driver = new FakeDriver()
  settings = { maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, model: null, verifyModel: null, briefModel: null, followupModel: null, billingFor: () => 'metered', pricesOf: () => ({ inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }) }
  log = vi.fn<(message: string) => void>()
  runner = new JobRunner({ repo, driver, clock, settings: () => settings, log })
  scheduler = { baseline: vi.fn(async (_ids: Id[]) => {}), topUpNow: vi.fn(async (_ids: Id[]) => {}) }
  deps = { repo, runner, clock, icons: { fetch: vi.fn(async () => null) }, scheduler }
  track = repo.createTrack({ name: '个人 Agent', brief: '能替人办事的 Agent', dimensions: [...DEFAULT_DIMENSIONS, { key: 'pricing-model', label: '定价模式' }], status: 'active' })
})
afterEach(async () => {
  await runner.stop()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** What the agent hands in for one product. */
const submission = (name: string, company: string, tier: CandidateTier, reason = '11 月向所有用户开放') => ({
  name, company, region: 'overseas', form: '网页', oneLiner: `${name}：能替你办事的 Agent`, tier, reason,
  officialUrl: 'https://gemini.google/agent/', articles: [{ url: `https://news.example/${encodeURIComponent(name)}`, title: `${name} 上线`, publishedAt: '2026-11-20' }],
})
/** A product Outpost follows in `trackId`, with a card for each default dimension. */
const followed = (trackId: Id, name: string, company: string) => {
  const p = repo.upsertProduct({ name, company, region: 'domestic', form: 'App', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
  repo.linkProduct(trackId, p.id)
  for (const dim of DEFAULT_DIMENSIONS) {
    repo.addCardVersion({ productId: p.id, dimension: dim.key, version: 1, summary: dim.label, bullets: ['一条'], body: '正文', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-20T00:00:00.000Z' })
  }
  return p
}
/** An agent that confirms this one product, then finishes. */
const confirms = (name: string, company: string, tier: CandidateTier = 'strong'): Play => async round => {
  await round.call('outpost_submit_candidate', submission(name, company, tier))
  await round.done(`已确认：${name}（${company}）`)
  return completed()
}

describe('startIdentify', () => {
  it('a passed identify joins the track and baselines the product', async () => {
    let second: unknown
    driver.script[IDENTIFY] = async round => {
      await round.call('outpost_submit_candidate', submission('Gemini Agent', 'Google', 'strong'))
      second = await round.call('outpost_submit_candidate', submission('Gemini Deep Research', 'Google', 'consider')) // only one product is confirmed
      await round.done('已确认：Gemini Agent（Google）')
      return completed()
    }

    const runId = await startIdentify(deps, track.id, { name: ' gemini agent ', officialUrl: 'https://gemini.google/agent/' })

    expect(repo.getRun(runId)).toMatchObject({ kind: 'identify', trackId: track.id, productId: null, subject: 'gemini agent' })
    await runner.idle()

    const joined = repo.productsOfTrack(track.id)
    expect(joined.map(p => [p.name, p.company, p.officialDomains])).toEqual([['Gemini Agent', 'Google', ['gemini.google']]])
    const product = joined[0]!
    expect(scheduler.baseline).toHaveBeenCalledTimes(1)
    expect(scheduler.baseline).toHaveBeenCalledWith([product.id])
    expect(scheduler.topUpNow).not.toHaveBeenCalled()
    // The run now names the product it confirmed, and finished without a remark.
    expect(repo.getRun(runId)).toMatchObject({ status: 'done', error: null, productId: product.id, subject: 'gemini agent' })
    expect(second).toEqual({ error: expect.stringContaining('只确认一个产品') })
    expect(repo.listCandidates(track.id, runId)).toHaveLength(1)
    expect(repo.findFollowedByName('Gemini Deep Research')).toEqual([])

    // The session: its title, its two tools, and what it is told.
    const spec = driver.runs[0]!
    expect(spec.title).toBe('前哨 · 确认产品 gemini agent')
    expect(spec.tools.map(t => t.name)).toEqual(['outpost_submit_candidate', 'outpost_done'])
    for (const told of ['个人 Agent', '能替人办事的 Agent', 'gemini agent', 'https://gemini.google/agent/', '2026-11-26']) expect(spec.prompt, told).toContain(told)
    expect(spec.prompt).not.toMatch(/\{\{|\}\}/)
  })

  it('a passed identify of a product tracked elsewhere only tops it up', async () => {
    const other = repo.createTrack({ name: '大模型助手', brief: '', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
    const tracked = repo.upsertProduct({ name: '千问Go!', company: '阿里巴巴', region: 'domestic', form: 'App', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
    repo.linkProduct(other.id, tracked.id)
    for (const dim of DEFAULT_DIMENSIONS) {
      repo.addCardVersion({ productId: tracked.id, dimension: dim.key, version: 1, summary: dim.label, bullets: ['一条'], body: '正文', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-20T00:00:00.000Z' })
    }
    // Typed in another spelling; the agent names it as it is known, a little differently from how Outpost keeps it.
    driver.script[IDENTIFY] = confirms('千问 Go', '阿里巴巴', 'consider')

    const runId = await startIdentify(deps, track.id, { name: 'Qwen Go', officialUrl: null })
    await runner.idle()

    expect(repo.productsOfTrack(track.id).map(p => p.id)).toEqual([tracked.id])
    expect(repo.productsOfTrack(other.id).map(p => p.id)).toEqual([tracked.id])
    expect(repo.getProduct(tracked.id)).toMatchObject({ status: 'tracking', name: '千问Go!' })
    expect(scheduler.topUpNow).toHaveBeenCalledTimes(1)
    expect(scheduler.topUpNow).toHaveBeenCalledWith([tracked.id]) // for the one dimension this track adds
    expect(scheduler.baseline.mock.calls.flat(2)).toEqual([]) // no baseline beside its daily run
    expect(repo.getRun(runId)).toMatchObject({ status: 'done', error: null, productId: tracked.id, subject: 'Qwen Go' })
    expect(driver.runs[0]!.prompt).not.toMatch(/\{\{|\}\}/)
  })

  it('a product handed in under another company joins the one followed under that name, not a second row', async () => {
    const other = repo.createTrack({ name: '大模型助手', brief: '', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
    const muse = followed(other.id, 'Muse', 'Meta')
    // The agent writes the company its own way: by name and company it would be another product, baselined and run twice.
    driver.script[IDENTIFY] = confirms('Muse', 'Meta Platforms')

    const runId = await startIdentify(deps, track.id, { name: 'Meta Muse', officialUrl: null })
    await runner.idle()

    expect(repo.productsOfTrack(track.id).map(p => p.id)).toEqual([muse.id])
    expect(repo.getRun(runId)).toMatchObject({ status: 'done', error: null, productId: muse.id })
    expect(scheduler.baseline.mock.calls.flat(2)).toEqual([]) // nothing baselined
    expect(scheduler.topUpNow).toHaveBeenCalledWith([muse.id]) // only what this track adds
    const handedIn = repo.getProduct(repo.listCandidates(track.id, runId)[0]!.productId)!
    expect(handedIn).toMatchObject({ name: 'Muse', company: 'Meta Platforms', status: 'candidate' }) // left as it is, in no track
    expect(repo.findFollowedByName('Muse').map(p => p.id)).toEqual([muse.id])
    // The agent was shown how the products followed are written, and told to copy them.
    const line = driver.runs[0]!.prompt.split('\n').find(l => l.includes('Muse（Meta）'))!
    expect(line).toContain('照抄')
  })

  it('a product handed in under another spelling of a followed name joins that product', async () => {
    const other = repo.createTrack({ name: '大模型助手', brief: '', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
    const qwen = followed(other.id, '千问Go!', '阿里巴巴')
    followed(other.id, 'Kimi', '月之暗面')
    // The user typed only part of the name; the agent keeps a spelling of its own and shortens the company.
    driver.script[IDENTIFY] = confirms('千问 GO', '阿里')

    const runId = await startIdentify(deps, track.id, { name: '千问', officialUrl: null })
    await runner.idle()

    expect(driver.runs[0]!.prompt).toContain('千问Go!（阿里巴巴）、Kimi（月之暗面）')
    expect(repo.productsOfTrack(track.id).map(p => p.id)).toEqual([qwen.id])
    expect(repo.getRun(runId)).toMatchObject({ status: 'done', productId: qwen.id })
    expect(scheduler.baseline.mock.calls.flat(2)).toEqual([])

    // Two products followed under that name (at two companies): the name alone cannot say which, so the agent's own
    // product stands, new to Outpost.
    const elsewhere = repo.createTrack({ name: '第三个', brief: '', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
    followed(elsewhere.id, '千问Go', '别家')
    const second = await startIdentify(deps, elsewhere.id, { name: '千问', officialUrl: null })
    await runner.idle()
    const own = repo.getProduct(repo.listCandidates(elsewhere.id, second)[0]!.productId)!
    expect(own).toMatchObject({ name: '千问 GO', company: '阿里' })
    expect(repo.getRun(second)).toMatchObject({ productId: own.id })
    expect(scheduler.baseline).toHaveBeenLastCalledWith([own.id])
  })

  it('says 处理结果时出错 when what the agent handed in cannot be acted on', async () => {
    driver.script[IDENTIFY] = confirms('Gemini Agent', 'Google')
    vi.spyOn(repo, 'linkProduct').mockImplementation(() => { throw new Error('database is locked') })

    const runId = await startIdentify(deps, track.id, { name: 'Gemini Agent', officialUrl: null })
    await runner.idle()

    expect(repo.getRun(runId)).toMatchObject({ status: 'done', error: SETTLE_FAILED, productId: null })
    expect(SETTLE_FAILED).toBe('处理结果时出错')
    expect(repo.productsOfTrack(track.id)).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('database is locked'))
  })

  it('an excluded or missing candidate adds nothing and records the reason', async () => {
    driver.script[IDENTIFY] = async round => {
      if (round.text.includes('Muse')) await round.call('outpost_submit_candidate', submission('Muse', 'Meta', 'excluded', '2026 年 9 月已停止服务'))
      await round.done('没通过')
      return completed({ inputTokens: 100_000 })
    }

    const excluded = await startIdentify(deps, track.id, { name: 'Muse', officialUrl: null })
    const missing = await startIdentify(deps, track.id, { name: '不存在的产品', officialUrl: null })
    await runner.idle()

    expect(repo.getRun(excluded)).toMatchObject({ status: 'done', error: '2026 年 9 月已停止服务', productId: null, subject: 'Muse' })
    expect(repo.getRun(missing)).toMatchObject({ status: 'done', error: '没有找到这个产品', productId: null, subject: '不存在的产品' })
    expect(NOT_FOUND).toBe('没有找到这个产品')
    // What the confirming cost is counted all the same.
    expect(repo.getRun(excluded)!.costYuan).toBeCloseTo(0.2)
    expect(repo.getRun(missing)!.costYuan).toBeCloseTo(0.2)
    expect(repo.productsOfTrack(track.id)).toEqual([])
    expect(scheduler.baseline).not.toHaveBeenCalled()
    expect(scheduler.topUpNow).not.toHaveBeenCalled()

    // A run the budget did not let start keeps that reason: the product was never looked for.
    settings.dailyBudgetYuan = 0.3
    const refused = await startIdentify(deps, track.id, { name: 'Gemini Agent', officialUrl: null })
    await runner.idle()
    expect(repo.getRun(refused)).toMatchObject({ status: 'skipped', error: '今日总预算已用完', productId: null })
    expect(driver.runs).toHaveLength(2)
  })

  it('a passed candidate stands whatever becomes of the session after it was handed in: the product joins and the run names it', async () => {
    // The agent hands the product in, then the session fails for a reason of its own (a model that stays down, a timeout,
    // the runner stopping). The check is done and the product joined, with its baseline paid for: the run carries it.
    const after: Record<string, () => ReturnType<typeof failure> | ReturnType<typeof completed>> = {
      'Gemini Agent': () => failure('model unavailable'),
      'Qwen Agent': () => ({ reason: 'timeout', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }),
    }
    driver.script[IDENTIFY] = async round => {
      const name = ['Gemini Agent', 'Qwen Agent'].find(n => round.text.includes(n))!
      await round.call('outpost_submit_candidate', submission(name, name === 'Gemini Agent' ? 'Google' : '阿里巴巴', 'strong')) // no outpost_done
      return after[name]!()
    }

    const errored = await startIdentify(deps, track.id, { name: 'Gemini Agent', officialUrl: null })
    const timedOut = await startIdentify(deps, track.id, { name: 'Qwen Agent', officialUrl: null })
    await runner.idle()

    const joined = new Map(repo.productsOfTrack(track.id).map(p => [p.name, p]))
    expect([...joined.keys()].sort()).toEqual(['Gemini Agent', 'Qwen Agent'])
    expect(repo.getRun(errored)).toMatchObject({ status: 'failed', error: 'model unavailable', productId: joined.get('Gemini Agent')!.id })
    expect(repo.getRun(timedOut)).toMatchObject({ status: 'failed', productId: joined.get('Qwen Agent')!.id })
    expect(repo.getRun(timedOut)!.error).toContain('30')
    expect(scheduler.baseline).toHaveBeenCalledWith([joined.get('Gemini Agent')!.id])
    expect(scheduler.baseline).toHaveBeenCalledWith([joined.get('Qwen Agent')!.id])
  })

  it('a passed candidate stands when the runner is stopped before the agent is done', async () => {
    driver.script[IDENTIFY] = async round => {
      await round.call('outpost_submit_candidate', submission('Gemini Agent', 'Google', 'strong'))
      await new Promise<void>(resolve => { round.signal.addEventListener('abort', () => { resolve() }) })
      return { reason: 'aborted', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }
    }

    const runId = await startIdentify(deps, track.id, { name: 'Gemini Agent', officialUrl: null })
    await vi.waitFor(() => { expect(repo.listCandidates(track.id, runId)).toHaveLength(1) })
    await runner.stop()

    const [product] = repo.productsOfTrack(track.id)
    expect(product).toMatchObject({ name: 'Gemini Agent' })
    expect(repo.getRun(runId)).toMatchObject({ status: 'failed', productId: product!.id })
    expect(repo.getRun(runId)!.error).toBeTruthy()
    expect(scheduler.baseline).toHaveBeenCalledWith([product!.id])
  })

  it('runs beside a recommendation without taking its batch or a place', async () => {
    settings.maxParallel = 1
    // The one place is taken by a product's daily session that goes on.
    const dailyHeld = gate()
    driver.script['outpost-daily-'] = async round => { await dailyHeld.promise; await round.done(); return completed() }
    const daily = runner.start('daily', { productId: 'busy' }, runId => ({
      title: '前哨 · 日更', prompt: '日更',
      tools: onDone => researchTools('daily', { repo, runId, trackId: null, productId: 'busy', now, icons: deps.icons, onDone }),
    }))
    // A recommendation of the track is running, its first candidate in.
    const recommendHeld = gate()
    driver.script['outpost-recommend-'] = async round => {
      await round.call('outpost_submit_candidate', submission('Manus', 'Butterfly Effect', 'strong'))
      await recommendHeld.promise
      await round.done()
      return completed()
    }
    const batchId = await startRecommendation(deps, track.id)
    await vi.waitFor(() => { expect(repo.listCandidates(track.id, batchId)).toHaveLength(1) })
    expect(repo.getRun(daily.run.id)!.status).toBe('running')

    driver.script[IDENTIFY] = confirms('Gemini Agent', 'Google')
    const runId = await startIdentify(deps, track.id, { name: 'Gemini Agent', officialUrl: null })

    // It ran to its end while the daily session held the only place and the recommendation went on.
    await vi.waitFor(() => { expect(repo.getRun(runId)!.status).toBe('done') })
    await vi.waitFor(() => { expect(repo.productsOfTrack(track.id).map(p => p.name)).toEqual(['Gemini Agent']) })
    expect(repo.getRun(daily.run.id)!.status).toBe('running')
    expect(repo.getRun(batchId)!.status).toBe('running')
    // The batch being picked from is still the recommendation's, with only its own candidates.
    expect(repo.latestBatchId(track.id)).toBe(batchId)
    expect(repo.listCandidates(track.id, batchId).map(c => repo.getProduct(c.productId)!.name)).toEqual(['Manus'])

    recommendHeld.open()
    dailyHeld.open()
    await runner.idle()
    expect(repo.getRun(batchId)!.status).toBe('done')
    expect(repo.latestBatchId(track.id)).toBe(batchId)
  })

  it('is never seen over without its outcome, however long its session takes to let go of', async () => {
    const letGo = gate()
    driver.release = async () => { await letGo.promise } // its browser closing slowly
    driver.script[IDENTIFY] = async round => {
      if (round.text.includes('Gemini Agent')) await round.call('outpost_submit_candidate', submission('Gemini Agent', 'Google', 'strong'))
      await round.done()
      return completed()
    }

    const passed = await startIdentify(deps, track.id, { name: 'Gemini Agent', officialUrl: null })
    const missing = await startIdentify(deps, track.id, { name: '不存在的产品', officialUrl: null })

    // As soon as a run reads as over, it names its product, or why there is none.
    await vi.waitFor(() => { expect([passed, missing].map(id => repo.getRun(id)!.status)).toEqual(['done', 'done']) })
    expect(driver.released).toEqual([])
    const product = repo.productsOfTrack(track.id)[0]!
    expect(repo.getRun(passed)).toMatchObject({ productId: product.id, error: null })
    expect(repo.getRun(missing)).toMatchObject({ productId: null, error: NOT_FOUND })
    expect(scheduler.baseline).toHaveBeenCalledWith([product.id])

    letGo.open()
    await runner.idle()
    expect(repo.getRun(passed)).toMatchObject({ status: 'done', productId: product.id, error: null })
  })

  it('throws for a track that does not exist, without starting anything', async () => {
    await expect(startIdentify(deps, 'no-such-track', { name: 'Gemini Agent', officialUrl: null })).rejects.toThrow('no-such-track')
    expect(repo.listRuns('')).toHaveLength(0)
  })
})
