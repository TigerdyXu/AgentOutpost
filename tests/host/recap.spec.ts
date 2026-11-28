import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { FindingStatus, Id, Importance, Track } from '../../src/core/types.ts'
import { composeRecap, describeWeek, parseRecapGist, recapDue, RECAP_GIST_MAX, weekStart, writeRecap, type RecapDeps } from '../../src/host/jobs/recap.ts'
import type { ModelClient } from '../../src/host/ports.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { usage } from '../fixtures/fake-driver.ts'

/** A local time on a day of November 2026, as the machine's clock has it. */
const at = (day: number, hour = 9) => new Date(2026, 10, day, hour)
const LAST_WEEK = '2026-11-23' // Monday 11-23 … Sunday 11-29
const TODAY = '2026-11-30' // the next Monday

let dir: string
let db: Db
let repo: Repo
let now: Date
let track: Track
let complete: ReturnType<typeof vi.fn<ModelClient['complete']>>
let budget: number
let deps: RecapDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-recap-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  now = at(20)
  repo = new Repo(db, () => now)
  track = repo.createTrack({ name: 'Personal Agent', brief: '能替人办事的 Agent', dimensions: DEFAULT_DIMENSIONS.slice(0, 2), status: 'active' })
  for (const [id, name] of [['p1', '小豆'], ['p2', 'Muse'], ['p3', 'Cue']] as const) {
    repo.upsertProduct({ id, name, company: `${name}公司`, region: 'domestic', form: 'App', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
    repo.linkProduct(track.id, id)
  }
  complete = vi.fn<ModelClient['complete']>(async () => ({ text: '「小豆开始按额度收费，Muse 扩到英国，Cue 整周没动静。」', usage: usage({ inputTokens: 3000, outputTokens: 120 }) }))
  budget = 10
  deps = {
    repo, model: { complete }, clock: { now: () => now, at: () => () => {}, tick: () => () => {} } as never,
    settings: () => ({ dailyBudgetYuan: budget, billingFor: () => 'metered', pricesOf: () => ({ inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.2 }), model: null, verifyModel: null, briefModel: null, followupModel: null }),
  }
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function finding(productId: Id, headline: string, when: Date, importance: Importance = 'notable', status: FindingStatus = 'verified') {
  now = when
  const run = repo.createRun({ kind: 'daily', date: '2026-11-25', trackId: null, productId })
  return repo.addFinding({
    productId, runId: run.id, headline, why: `${headline}的原因`, importance, claimKind: 'self', sourceIds: [], status, statusNote: null,
    unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: headline, verifiedOn: null,
  })
}
function card(productId: Id, dimension: string, version: number, when: Date, changeNote = '建档') {
  repo.addCardVersion({ productId, dimension, version, summary: 's', bullets: ['b'], body: 'b', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote, findingIds: [], createdAt: when.toISOString() })
}

describe('weeks', () => {
  it('start on Monday', () => {
    expect(['2026-11-23', '2026-11-26', '2026-11-29'].map(weekStart)).toEqual(['2026-11-23', '2026-11-23', '2026-11-23'])
    expect(weekStart('2026-11-30')).toBe('2026-11-30')
    expect(weekStart('2027-01-03')).toBe('2026-12-28') // across a year
  })
})

describe('composeRecap', () => {
  it('reads what the week held, by the user’s calendar, from Monday to Sunday', () => {
    card('p1', 'positioning', 1, at(16)) // profiled before the week
    card('p1', 'positioning', 2, at(25), '加了定价')
    card('p2', 'positioning', 1, at(24)) // first profiled in the week
    card('p2', 'audience', 1, at(24))
    finding('p1', '小豆开始收费', at(25), 'major')
    finding('p2', 'Muse 进英国', at(27))
    finding('p2', '据传要涨价', at(28), 'notable', 'unconfirmed')
    finding('p2', '小改版', at(26), 'minor')
    finding('p1', '上周日晚上的', at(22, 23)) // the Sunday before: not this week
    finding('p1', '下周一的', at(30, 1)) // the Monday after
    finding('p1', '撤回的', at(25), 'major', 'withdrawn')
    const recap = composeRecap(repo, track, LAST_WEEK, TODAY)
    expect(recap).toMatchObject({ week: LAST_WEEK, end: '2026-11-29', complete: true, gist: null, minor: 1, quiet: ['Cue'] })
    expect(recap.findings.map(f => [f.product, f.headline, f.date])).toEqual([
      ['小豆', '小豆开始收费', '2026-11-25'], ['Muse', '据传要涨价', '2026-11-28'], ['Muse', 'Muse 进英国', '2026-11-27'],
    ])
    expect(recap.cardChanges).toEqual([{ productId: 'p1', product: '小豆', dimension: 'positioning', label: '定位', changeNote: '加了定价', date: '2026-11-25' }])
    expect(recap.newProducts).toEqual([{ id: 'p2', name: 'Muse' }])
    expect(composeRecap(repo, track, '2026-11-30', TODAY)).toMatchObject({ complete: false, findings: [{ headline: '下周一的' }] })
  })

  it('names the products the week’s map moved since the drawing before, on the same axes only', () => {
    const axes = { x: { low: '寄生', high: '独立' }, y: { low: '陪聊', high: '办事' } }
    repo.addLandscape({ trackId: track.id, date: '2026-11-20', gist: '旧格局', axes, positions: [{ productId: 'p1', x: 0, y: 0, why: '' }, { productId: 'p2', x: 10, y: 10, why: '' }], runId: null, createdAt: at(20).toISOString() })
    repo.addLandscape({ trackId: track.id, date: '2026-11-26', gist: '新格局', axes, positions: [{ productId: 'p1', x: 30, y: 5, why: '' }, { productId: 'p2', x: 15, y: 12, why: '' }], runId: null, createdAt: at(26).toISOString() })
    expect(composeRecap(repo, track, LAST_WEEK, TODAY).map).toEqual({ date: '2026-11-26', gist: '新格局', moved: ['小豆'] })
    repo.addLandscape({ trackId: track.id, date: '2026-11-27', gist: '换了轴', axes: { ...axes, x: { low: 'a', high: 'b' } }, positions: [{ productId: 'p1', x: -90, y: 0, why: '' }], runId: null, createdAt: at(27).toISOString() })
    expect(composeRecap(repo, track, LAST_WEEK, TODAY).map).toEqual({ date: '2026-11-27', gist: '换了轴', moved: [] })
  })

  it('lists the topics with a new version in the week, and says which weeks it can move to', () => {
    const topic = repo.createTopic({ trackId: track.id, question: '谁在收费？', productIds: ['p1'], cadence: 'weekly' })
    now = at(26)
    const draft = repo.addTopicDraft(topic.id)
    repo.updateTopicVersion(draft.id, { status: 'final', version: 1, changeNote: '第一版', cards: [] })
    const recap = composeRecap(repo, track, LAST_WEEK, TODAY)
    expect(recap.topics).toEqual([{ id: topic.id, question: '谁在收费？', version: 1, changeNote: '第一版', date: '2026-11-26' }])
    expect([recap.prev, recap.next]).toEqual(['2026-11-16', '2026-11-30']) // the track was made on 11-20
    expect(composeRecap(repo, track, '2026-11-16', TODAY).prev).toBeNull()
    expect(composeRecap(repo, track, '2026-11-30', TODAY).next).toBeNull()
  })
})

describe('describeWeek and parseRecapGist', () => {
  it('tells the model the week’s material, and says so when there is none', () => {
    finding('p1', '小豆开始收费', at(25), 'major')
    card('p1', 'positioning', 1, at(16))
    card('p1', 'positioning', 2, at(25), '加了定价')
    const text = describeWeek(track, composeRecap(repo, track, LAST_WEEK, TODAY))
    for (const part of ['赛道：Personal Agent', '上周：2026-11-23 到 2026-11-29', '- 小豆（11-25，重大）小豆开始收费：小豆开始收费的原因', '- 小豆 · 定位：加了定价', '整周没动静：Muse、Cue'])
      expect(text, part).toContain(part)
    expect(text).not.toContain('\n\n\n') // one blank line between parts
    expect(describeWeek(track, composeRecap(repo, track, '2026-11-09', TODAY))).toBe('赛道：Personal Agent\n关注：能替人办事的 Agent\n上周：2026-11-09 到 2026-11-15\n\n这周没有新东西。')
  })

  it('keeps one paragraph of at most RECAP_GIST_MAX characters', () => {
    expect(parseRecapGist('「上周回顾：小豆开始收费。\n\nMuse 扩到英国。」')).toBe('小豆开始收费。Muse 扩到英国。')
    expect(parseRecapGist('   ')).toBeNull()
    expect(parseRecapGist('长'.repeat(RECAP_GIST_MAX + 1))).toBeNull()
  })
})

describe('writeRecap', () => {
  it('writes the paragraph as a recap run, priced by the brief’s model', async () => {
    finding('p1', '小豆开始收费', at(25), 'major')
    now = at(30, 8)
    const kept = await writeRecap(deps, track.id, LAST_WEEK, TODAY)
    expect(kept).toMatchObject({ trackId: track.id, week: LAST_WEEK, gist: '小豆开始按额度收费，Muse 扩到英国，Cue 整周没动静。' })
    expect(repo.getRecap(track.id, LAST_WEEK)?.gist).toBe(kept!.gist)
    expect(repo.runsOfDate(TODAY, 'recap')).toMatchObject([{ status: 'done', trackId: track.id, costYuan: expect.any(Number), error: null }])
    expect(complete.mock.calls[0]![0].user).toContain('小豆开始收费')
  })

  it('writes nothing when the budget is spent, the answer is unusable, or the call fails, and says why on the run', async () => {
    budget = 0
    expect(await writeRecap(deps, track.id, LAST_WEEK, TODAY)).toBeNull()
    budget = 10
    complete.mockResolvedValueOnce({ text: '长'.repeat(RECAP_GIST_MAX + 5), usage: usage() })
    expect(await writeRecap(deps, track.id, LAST_WEEK, TODAY)).toBeNull()
    complete.mockRejectedValueOnce(new Error('429 Too Many Requests'))
    expect(await writeRecap(deps, track.id, LAST_WEEK, TODAY)).toBeNull()
    expect(repo.runsOfDate(TODAY, 'recap').map(r => [r.status, r.error?.slice(0, 12)])).toEqual([
      ['skipped', '今日总预算已用完'], ['done', '模型给的周回顾总结用不了'.slice(0, 12)], ['failed', '429 Too Many'],
    ])
    expect(repo.getRecap(track.id, LAST_WEEK)).toBeNull()
  })
})

describe('recapDue', () => {
  it('is last week, once, when the track was there and the week held something', async () => {
    expect(recapDue(repo, track, TODAY)).toBeNull() // nothing happened last week
    finding('p1', '小豆开始收费', at(25), 'major')
    expect(recapDue(repo, track, TODAY)).toBe(LAST_WEEK)
    expect(recapDue(repo, track, '2026-12-02')).toBe(LAST_WEEK) // any day of the next week
    expect(recapDue(repo, track, '2026-12-07')).toBeNull() // two weeks on: 11-30's week held nothing
    complete.mockRejectedValueOnce(new Error('down'))
    await writeRecap(deps, track.id, LAST_WEEK, TODAY)
    expect(recapDue(repo, track, TODAY)).toBeNull() // tried today already
    expect(recapDue(repo, track, '2026-12-01')).toBe(LAST_WEEK) // tried again the next day
    await writeRecap(deps, track.id, LAST_WEEK, '2026-12-01')
    expect(recapDue(repo, track, '2026-12-02')).toBeNull() // written
  })

  it('is never for a track made after the week, or one not active', () => {
    finding('p1', '小豆开始收费', at(25), 'major')
    now = at(30, 7)
    const late = repo.createTrack({ name: '新赛道', brief: '', dimensions: DEFAULT_DIMENSIONS.slice(0, 1), status: 'active' })
    repo.linkProduct(late.id, 'p1')
    expect(recapDue(repo, late, TODAY)).toBeNull()
    expect(recapDue(repo, { ...track, status: 'archived' }, TODAY)).toBeNull()
  })
})
