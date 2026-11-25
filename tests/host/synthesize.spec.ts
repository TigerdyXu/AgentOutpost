import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_NEWS_GIST } from '../../src/core/brief.ts'
import { costOf } from '../../src/core/cost.ts'
import type { Finding, Id, Importance, Run, RunStatus } from '../../src/core/types.ts'
import { VERIFY_BUDGET_NOTE } from '../../src/host/jobs/daily.ts'
import type { RuntimeSettings } from '../../src/host/jobs/runner.ts'
import { GIST_MAX_CHARS, appendLate, cleanGist, synthesizeBrief, type BriefDeps } from '../../src/host/jobs/synthesize.ts'
import { PROMOTED_NOTE } from '../../src/host/jobs/verify.ts'
import type { ModelClient } from '../../src/host/ports.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { instantClock, usage } from '../fixtures/fake-driver.ts'

const DAY = '2026-11-25'
const DAY_3 = '2026-11-27'
const PRICES = { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }
const USED = usage({ inputTokens: 2_000, outputTokens: 100 })

let dir: string
let db: Db
let repo: Repo
let time: ReturnType<typeof instantClock>
let settings: Pick<RuntimeSettings, 'dailyBudgetYuan' | 'prices'>
let answer: string | Error
let complete: ReturnType<typeof vi.fn<ModelClient['complete']>>
let deps: BriefDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-synthesize-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  time = instantClock(new Date(2026, 10, 25, 9, 30, 0))
  repo = new Repo(db, () => time.clock.now())
  settings = { dailyBudgetYuan: 20, prices: PRICES }
  answer = '今天 Cursor 后台 Agent 正式上线，Windsurf 降价仍待确认。'
  complete = vi.fn<ModelClient['complete']>(async () => {
    if (answer instanceof Error) throw answer
    return { text: answer, usage: USED }
  })
  deps = { repo, model: { complete }, clock: time.clock, settings: () => settings }
  const track = repo.createTrack({ name: 'AI 编程助手', brief: '盯住编程类 Agent', dimensions: [{ key: 'positioning', label: '定位' }], status: 'active' })
  for (const [id, name] of [['p1', 'Cursor'], ['p2', 'Windsurf'], ['p3', 'Cline'], ['p4', 'Zed'], ['p5', 'Trae']] as const) {
    repo.upsertProduct({ id, name, company: `${name} Inc`, region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
    repo.linkProduct(track.id, id)
  }
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A daily run of the product on that day, ended as given. */
const daily = (productId: Id, status: RunStatus = 'done', over: Partial<Run> = {}, date = DAY): Run => {
  const run = repo.createRun({ kind: 'daily', date, trackId: null, productId })
  repo.updateRun(run.id, { status, endedAt: time.clock.now().toISOString(), ...over })
  return repo.getRun(run.id)!
}
/** A finding handed in by that run, already checked as given. */
const found = (run: Run, headline: string, over: Partial<Omit<Finding, 'id' | 'createdAt'>> = {}): Finding => repo.addFinding({
  productId: run.productId!, runId: run.id, headline, why: `${headline}，值得看`, importance: 'major' as Importance, claimKind: 'self', sourceIds: [],
  status: 'verified', statusNote: null, unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false,
  dedupeKey: headline, verifiedOn: over.status === undefined || over.status === 'verified' ? run.date : null, ...over,
})
const synthRuns = (date = DAY) => repo.runsOfDate(date, 'synthesize')

describe('synthesizeBrief', () => {
  it('uses the no-news gist without calling the model when nothing happened', async () => {
    const r1 = daily('p1')
    daily('p2')
    found(r1, '还没核查完', { status: 'pending' })
    found(r1, '被撤回的传闻', { status: 'withdrawn' })

    const brief = await synthesizeBrief(deps, DAY)

    expect(brief).toMatchObject({ date: DAY, gist: NO_NEWS_GIST, findingIds: [], minorIds: [], quietProductIds: ['p1', 'p2'], skipped: [] })
    expect(complete).not.toHaveBeenCalled()
    expect(synthRuns()).toEqual([]) // nothing was spent on it
    expect(repo.getBrief(DAY)).toEqual(brief)
  })

  it('does not call the model for minor updates alone', async () => {
    const minor = found(daily('p1'), '修了几个小问题', { importance: 'minor' })

    const brief = await synthesizeBrief(deps, DAY)

    expect(brief).toMatchObject({ gist: NO_NEWS_GIST, findingIds: [], minorIds: [minor.id] })
    expect(complete).not.toHaveBeenCalled()
  })

  it('writes the gist from the shown findings only, and counts its cost in a synthesize run of that day', async () => {
    const r1 = daily('p1', 'done', { costYuan: 0.5 })
    const r2 = daily('p2', 'done', { costYuan: 0.25 })
    const major = found(r1, 'Cursor 后台 Agent 正式上线')
    const notable = found(r2, 'Windsurf 传出降价消息', { importance: 'notable', status: 'unconfirmed', claimKind: 'third-party' })
    found(r1, '还在核查的消息', { status: 'pending' })
    found(r2, '被撤回的传闻', { status: 'withdrawn' })
    answer = '「今天 Cursor 后台 Agent 正式上线，\nWindsurf 降价仍待确认。」\n'

    const brief = await synthesizeBrief(deps, DAY)

    expect(brief.gist).toBe('今天 Cursor 后台 Agent 正式上线， Windsurf 降价仍待确认。')
    expect(brief.findingIds).toEqual([major.id, notable.id])
    expect(complete).toHaveBeenCalledOnce()
    const [request, signal] = complete.mock.calls[0]!
    expect(signal).toBeInstanceOf(AbortSignal)
    for (const rule of ['一句话', '60', '只依据', '不加', '待确认']) expect(request.system, rule).toContain(rule)
    expect(request.system).not.toMatch(/\{\{|\}\}/)
    // The model sees the shown findings, most important first, and nothing else.
    expect(request.user).toContain(DAY)
    expect(request.user.indexOf('Cursor 后台 Agent 正式上线')).toBeLessThan(request.user.indexOf('Windsurf 传出降价消息'))
    expect(request.user).toContain('待确认')
    expect(request.user).not.toContain('还在核查的消息')
    expect(request.user).not.toContain('被撤回的传闻')

    const cost = costOf(USED, PRICES)
    expect(synthRuns()).toMatchObject([{ kind: 'synthesize', date: DAY, status: 'done', error: null, usage: USED, costYuan: cost }])
    expect(brief.costYuan).toBeCloseTo(0.5 + 0.25 + cost, 6) // the day's whole spending, the gist included
  })

  it('falls back to a sentence from the top finding when the answer is empty, too long, or missing', async () => {
    const r1 = daily('p1')
    found(r1, '后台 Agent 正式上线')
    found(r1, '团队版涨价', { importance: 'notable' })
    const expected = 'Cursor：后台 Agent 正式上线；另有 1 条值得看'

    for (const bad of ['', ' 「」 \n', '长'.repeat(GIST_MAX_CHARS + 1)]) {
      answer = bad
      expect((await synthesizeBrief(deps, DAY)).gist, JSON.stringify(bad)).toBe(expected)
    }
    expect(synthRuns().map(r => r.status)).toEqual(['done', 'done', 'done'])
    expect(synthRuns()[2]!.error).toContain('60') // the note says why the answer was not used

    answer = new Error('模型服务暂时不可用')
    expect((await synthesizeBrief(deps, DAY)).gist).toBe(expected)
    expect(synthRuns()[3]).toMatchObject({ status: 'failed', error: '模型服务暂时不可用' })

    answer = '长'.repeat(GIST_MAX_CHARS) // exactly 60 is fine
    expect((await synthesizeBrief(deps, DAY)).gist).toBe('长'.repeat(GIST_MAX_CHARS))
  })

  it('keeps the fallback within 60 字 and says when the top finding is unconfirmed', async () => {
    const run = daily('p2')
    found(run, 'Windsurf 传出降价消息', { status: 'unconfirmed' })
    answer = ''
    expect((await synthesizeBrief(deps, DAY)).gist).toBe('Windsurf 传出降价消息（待确认）') // the headline names the product already

    repo.upsertProduct({ id: 'p2', name: '名'.repeat(30), company: 'Windsurf Inc', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null })
    found(run, '标'.repeat(30))
    const gist = (await synthesizeBrief(deps, DAY)).gist
    expect([...gist].length).toBeLessThanOrEqual(GIST_MAX_CHARS)
    expect(gist).toContain('标'.repeat(30))
  })

  it('skips the model when the day\'s budget is used up', async () => {
    found(daily('p1', 'done', { costYuan: 20 }), '后台 Agent 正式上线')

    const brief = await synthesizeBrief(deps, DAY)

    expect(complete).not.toHaveBeenCalled()
    expect(brief.gist).toBe('Cursor：后台 Agent 正式上线')
    expect(synthRuns()).toMatchObject([{ status: 'skipped', error: '今日总预算已用完' }])
  })

  it('names skipped and failed products, and does not call a product still running quiet', async () => {
    daily('p1')
    daily('p2', 'skipped', { error: '今日总预算已用完' })
    daily('p3', 'failed', { error: '会话出错' })
    daily('p3', 'failed', { error: '超过 30 分钟没有结束，已停止' })
    daily('p4', 'running')
    daily('p5', 'done', { error: VERIFY_BUDGET_NOTE }) // it ran, but what it found is unchecked: not "quiet"

    const brief = await synthesizeBrief(deps, DAY)

    expect(brief.skipped).toEqual([
      { productId: 'p2', reason: '今日总预算已用完' },
      { productId: 'p3', reason: '超过 30 分钟没有结束，已停止', failed: true },
      { productId: 'p5', reason: VERIFY_BUDGET_NOTE },
    ])
    expect(brief.quietProductIds).toEqual(['p1'])
  })

  it('counts a product done once any run of the day is done, and an interrupted one as not finished', async () => {
    daily('p1', 'skipped', { error: '今日总预算已用完' })
    daily('p1', 'done') // 立即更新 after the budget was raised
    daily('p2', 'failed', { error: '前哨已停止' }) // interrupted by a stop: it will run again

    const brief = await synthesizeBrief(deps, DAY)

    expect(brief.skipped).toEqual([])
    expect(brief.quietProductIds).toEqual(['p1'])
  })

  it('shows a finding promoted on a later day in that day\'s brief and keeps it in its own day\'s', async () => {
    const day1 = daily('p1')
    const waiting = found(day1, 'Windsurf 用户破百万', { status: 'unconfirmed', claimKind: 'third-party', unconfirmedUntil: '2026-12-02T09:30:00.000Z' })
    const day1Brief = await synthesizeBrief(deps, DAY)
    expect(day1Brief.findingIds).toEqual([waiting.id])

    // Day 3: the check finds a second source and promotes it; the same check verifies a finding of day 3 itself.
    time.set(new Date(2026, 10, 27, 9, 30, 0))
    const day3 = daily('p1', 'done', {}, DAY_3)
    const fresh = found(day3, 'Cursor 发布 2.2', { importance: 'notable' })
    repo.updateFinding(waiting.id, { status: 'verified', statusNote: PROMOTED_NOTE, unconfirmedUntil: null, verifiedOn: DAY_3 })

    const day3Brief = await synthesizeBrief(deps, DAY_3)

    expect(day3Brief.findingIds).toEqual([waiting.id, fresh.id]) // once each: the day's own verification is not doubled
    expect(day3Brief.quietProductIds).toEqual([])
    expect(complete.mock.calls.at(-1)![0].user).toContain('Windsurf 用户破百万')
    expect(repo.getBrief(DAY)!.findingIds).toEqual([waiting.id]) // still in the brief of its own day
    // How the panel tells it apart (documented in synthesize.ts): verified that day, as a promotion.
    expect(repo.getFinding(waiting.id)).toMatchObject({ verifiedOn: DAY_3, statusNote: PROMOTED_NOTE })
  })

  it('keeps the creation time of the day\'s earlier brief', async () => {
    daily('p1')
    const first = await synthesizeBrief(deps, DAY)
    time.set(new Date(2026, 10, 25, 11, 0, 0))
    const second = await synthesizeBrief(deps, DAY)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).not.toBe(first.updatedAt)
  })
})

describe('appendLate', () => {
  it('adds a product that finished after the cutoff, marked 迟到, and keeps the gist', async () => {
    const r1 = daily('p1')
    const early = found(r1, 'Cursor 后台 Agent 正式上线')
    const r2 = daily('p2', 'running')
    await synthesizeBrief(deps, DAY)
    const gist = repo.getBrief(DAY)!.gist
    expect(repo.getBrief(DAY)!.quietProductIds).toEqual([]) // Windsurf is still running: not 「今天没动静」

    // Windsurf finishes at 10:40, after the 10:00 cutoff.
    repo.updateRun(r2.id, { status: 'done' })
    const late = found(r2, 'Windsurf 发布 Wave 9', { importance: 'notable' })
    const quietLate = found(r2, 'Windsurf 修了几个小问题', { importance: 'minor' })
    answer = '不该再生成'

    const brief = await appendLate(deps, DAY, 'p2')

    expect(brief.gist).toBe(gist)
    expect(complete).toHaveBeenCalledOnce() // only the first synthesis
    expect(brief.findingIds).toEqual([early.id, late.id])
    expect(brief.minorIds).toEqual([quietLate.id])
    expect(repo.getFinding(late.id)!.late).toBe(true)
    expect(repo.getFinding(quietLate.id)!.late).toBe(true)
    expect(repo.getFinding(early.id)!.late).toBe(false) // already in the brief before the cutoff
    expect(repo.getBrief(DAY)).toEqual(brief)
  })

  it('writes a gist when the brief had none and the late product brings news', async () => {
    daily('p1')
    const r2 = daily('p2', 'running')
    expect((await synthesizeBrief(deps, DAY)).gist).toBe(NO_NEWS_GIST)
    expect(complete).not.toHaveBeenCalled()

    repo.updateRun(r2.id, { status: 'done' })
    const late = found(r2, 'Windsurf 发布 Wave 9')
    answer = 'Windsurf 迟到的 Wave 9 是今天唯一的大事。'

    const brief = await appendLate(deps, DAY, 'p2')

    expect(complete).toHaveBeenCalledOnce()
    expect(brief.gist).toBe('Windsurf 迟到的 Wave 9 是今天唯一的大事。')
    expect(brief.findingIds).toEqual([late.id])
    expect(repo.getFinding(late.id)!.late).toBe(true)
  })

  it('keeps the no-news gist when the late product brings only minor updates', async () => {
    const r1 = daily('p1', 'running')
    await synthesizeBrief(deps, DAY)
    repo.updateRun(r1.id, { status: 'done' })
    found(r1, '修了几个小问题', { importance: 'minor' })

    expect((await appendLate(deps, DAY, 'p1')).gist).toBe(NO_NEWS_GIST)
    expect(complete).not.toHaveBeenCalled()
  })

  it('makes the brief when the day has none yet', async () => {
    const f = found(daily('p1'), 'Cursor 后台 Agent 正式上线')

    const brief = await appendLate(deps, DAY, 'p1')

    expect(brief.findingIds).toEqual([f.id])
    expect(repo.getFinding(f.id)!.late).toBe(false) // nothing came before it, so it is not late
    expect(repo.getBrief(DAY)).toEqual(brief)
  })
})

describe('cleanGist', () => {
  it('strips quotes, labels and line breaks, and refuses what is empty or over 60 字', () => {
    expect(cleanGist('"Cursor 上线后台 Agent。"')).toBe('Cursor 上线后台 Agent。')
    expect(cleanGist('一句话总结：「Cursor 上线后台 Agent。」')).toBe('Cursor 上线后台 Agent。')
    expect(cleanGist('Cursor 上线后台 Agent，\r\n\r\nWindsurf 降价。')).toBe('Cursor 上线后台 Agent， Windsurf 降价。')
    expect(cleanGist('  \n')).toBeNull()
    expect(cleanGist('“”')).toBeNull()
    expect(cleanGist('字'.repeat(60))).toBe('字'.repeat(60))
    expect(cleanGist('字'.repeat(61))).toBeNull()
    expect(cleanGist('😀'.repeat(60))).toBe('😀'.repeat(60)) // counted in characters, not UTF-16 units
  })
})
