import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_NEWS_GIST } from '../../src/core/brief.ts'
import { localDate } from '../../src/core/calendar.ts'
import type { Id, Importance, Run, RunStatus } from '../../src/core/types.ts'
import { STOPPED_ERROR, type RuntimeSettings } from '../../src/host/jobs/runner.ts'
import { appendLate, synthesizeBrief, type BriefDeps } from '../../src/host/jobs/synthesize.ts'
import type { ModelClient } from '../../src/host/ports.ts'
import { LAST_COMPLETED, Scheduler, type SchedulerDeps } from '../../src/host/scheduler.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { flush, gate, usage } from '../fixtures/fake-driver.ts'
import { local, manualClock } from '../fixtures/manual-clock.ts'

const DAY = '2026-11-25'
const trackedCount = 3

/** How one daily run of a product ends, and what it hands in (already checked: verified). */
interface Outcome { status?: RunStatus; error?: string; findings?: { headline: string; importance?: Importance }[] }

let dir: string
let db: Db
let repo: Repo
/** The test's clock: `clock.set` moves it, `clock.clock` is what the code under test reads. */
let clock: ReturnType<typeof manualClock>
let settings: RuntimeSettings & { runTime: string }
let complete: ReturnType<typeof vi.fn<ModelClient['complete']>>
let log: ReturnType<typeof vi.fn<(message: string) => void>>
let deps: SchedulerDeps
let scheduler: Scheduler
let plays: Record<Id, Outcome[]>
let holds: Record<Id, ReturnType<typeof gate>>
let events: string[]
let mapsFail = false
let calls: { runDailyProduct: { productId: Id; date: string }[]; archiveOld: Date[]; rebaseline: Id[][]; verifyProduct: { productId: Id; date: string }[] }
let trackId: Id

const addProduct = (id: Id, name: string, status: 'tracking' | 'baselining' | 'paused' = 'tracking', withCard = true) => {
  repo.upsertProduct({ id, name, company: `${name} Inc`, region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status, dailyBudgetYuan: null })
  repo.linkProduct(trackId, id)
  if (withCard) repo.addCardVersion({ productId: id, dimension: 'positioning', version: 1, summary: '编辑器', bullets: ['基于 VS Code'], body: '编辑器[1]', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-20T00:00:00.000Z' })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-scheduler-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  clock = manualClock('2026-11-25T07:00')
  repo = new Repo(db, () => clock.clock.now())
  settings = { runTime: '08:00', maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, model: null, verifyModel: null, briefModel: null, followupModel: null, billingFor: () => 'metered', pricesOf: () => ({ inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 }) }
  complete = vi.fn<ModelClient['complete']>(async () => ({ text: '今天 Cursor 有一条重要更新。', usage: usage({ inputTokens: 1000 }) }))
  log = vi.fn<(message: string) => void>()
  plays = {}
  holds = {}
  events = []
  calls = { runDailyProduct: [], archiveOld: [], rebaseline: [], verifyProduct: [] }
  mapsFail = false
  trackId = repo.createTrack({ name: 'AI 编程助手', brief: '盯住编程类 Agent', dimensions: [{ key: 'positioning', label: '定位' }], status: 'active' }).id
  addProduct('p1', 'Cursor')
  addProduct('p2', 'Windsurf')
  addProduct('p3', 'Cline')

  const briefDeps: BriefDeps = { repo, model: { complete }, clock: clock.clock, settings: () => settings }
  deps = {
    clock: clock.clock,
    repo,
    settings: () => settings,
    runDailyProduct: async (productId, date) => {
      calls.runDailyProduct.push({ productId, date })
      events.push(`daily ${productId}`)
      const run = repo.createRun({ kind: 'daily', date, trackId: null, productId })
      repo.updateRun(run.id, { status: 'running' })
      await holds[productId]?.promise
      const outcome = plays[productId]?.shift() ?? {}
      for (const f of outcome.findings ?? []) {
        repo.addFinding({
          productId, runId: run.id, headline: f.headline, why: '值得看', importance: f.importance ?? 'major', claimKind: 'self', sourceIds: [], status: 'verified',
          statusNote: null, unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: f.headline, verifiedOn: date,
        })
      }
      repo.updateRun(run.id, { status: outcome.status ?? 'done', error: outcome.error ?? null, endedAt: clock.clock.now().toISOString() })
      events.push(`daily ${productId} ${outcome.status ?? 'done'}`)
      return repo.getRun(run.id)!
    },
    synthesize: date => { events.push(`brief ${date}`); return synthesizeBrief(briefDeps, date) },
    appendLate: (date, productId) => appendLate(briefDeps, date, productId),
    archiveOld: async now => { calls.archiveOld.push(now); events.push('archive') },
    drawMaps: async date => { events.push(`maps ${date}`); if (mapsFail) throw new Error('model down') },
    suggestWeekly: async date => { events.push(`weekly ${date}`) },
    rebaseline: async ids => { calls.rebaseline.push(ids); events.push(`rebaseline ${ids.join(',')}`) },
    verifyProduct: async (productId, date) => {
      calls.verifyProduct.push({ productId, date })
      events.push(`check ${productId}`)
      const run = repo.createRun({ kind: 'verify', date, trackId: null, productId })
      await holds[`check ${productId}`]?.promise
      repo.updateRun(run.id, { status: 'done', endedAt: clock.clock.now().toISOString() })
      events.push(`check ${productId} done`)
    },
    log,
  }
  scheduler = new Scheduler(deps)
})
afterEach(() => {
  scheduler.stop()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const dailyIds = () => calls.runDailyProduct.map(c => c.productId)
/** A baseline run of the product today, as the baseline job leaves it: started and ended as given, or skipped by the budget (never started). */
const recordBaseline = (productId: Id, status: 'done' | 'failed' | 'skipped') => {
  const now = clock.clock.now().toISOString()
  const run = repo.createRun({ kind: 'baseline', date: localDate(clock.clock.now()), trackId: null, productId })
  repo.updateRun(run.id, { status, startedAt: status === 'skipped' ? null : now, endedAt: now, error: status === 'done' ? null : '没能建档' })
}
const seedRun = (productId: Id, status: RunStatus, error: string | null = null, date = DAY): Run => {
  const run = repo.createRun({ kind: 'daily', date, trackId: null, productId })
  repo.updateRun(run.id, { status, error })
  return repo.getRun(run.id)!
}

describe('Scheduler: when to run', () => {
  it('catches up once after a missed run', async () => {
    clock.set('2026-11-25T14:00'); repo.setSetting('lastCompletedDailyDate', '2026-11-24'); scheduler.start()
    await flush(); expect(calls.runDailyProduct).toHaveLength(trackedCount); expect(repo.getBrief('2026-11-25')).not.toBeNull()
    scheduler.start(); await flush(); expect(calls.runDailyProduct).toHaveLength(trackedCount)

    expect(calls.runDailyProduct.every(c => c.date === DAY)).toBe(true)
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
    expect(clock.pending()).toEqual([local('2026-11-26T08:00')]) // one timer, for tomorrow
  })

  it('resumes only unfinished products', async () => {
    const lastRunId = repo.createRun({ kind: 'daily', date: '2026-11-25', productId: 'p1', trackId: null }).id; repo.updateRun(lastRunId, { status: 'done' })
    seedRun('p2', 'running') // left behind when the desktop app was quit mid-run
    clock.set('2026-11-25T14:00'); scheduler.start(); await flush()
    expect(calls.runDailyProduct.map(c => c.productId)).toEqual(['p2', 'p3'])

    expect(repo.getBrief(DAY)!.quietProductIds).toEqual(['p1', 'p2', 'p3']) // the brief covers the products done before the restart too
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
  })

  it('waits for the run time when started before it', async () => {
    repo.setSetting(LAST_COMPLETED, '2026-11-24')
    scheduler.start()
    await flush()

    expect(calls.runDailyProduct).toEqual([])
    expect(clock.pending()).toEqual([local('2026-11-25T08:00')])

    clock.set('2026-11-25T08:00')
    await flush()
    expect(dailyIds()).toEqual(['p1', 'p2', 'p3'])
    expect(clock.pending()).toEqual([local('2026-11-26T08:00')])
  })

  it('runs once, and arms for tomorrow, when started exactly at the run time', async () => {
    clock.set('2026-11-25T08:00')
    scheduler.start()
    await flush()
    expect(calls.runDailyProduct).toHaveLength(trackedCount)
    expect(clock.pending()).toEqual([local('2026-11-26T08:00')])

    clock.set('2026-11-25T08:00:01')
    scheduler.start()
    await flush()
    expect(calls.runDailyProduct).toHaveLength(trackedCount)
  })

  it('writes the brief of a day interrupted before its cutoff on the next start, without new research', async () => {
    settings.maxParallel = 1
    plays.p1 = [{ findings: [{ headline: 'Cursor 后台 Agent 正式上线' }] }]
    plays.p2 = [{ status: 'failed', error: STOPPED_ERROR }] // the desktop app was quit at 08:40
    clock.set('2026-11-25T08:00')
    await scheduler.runDay(DAY)
    expect(repo.getBrief(DAY)).toBeNull()

    clock.set('2026-11-26T09:00')
    events.length = 0
    const next = new Scheduler(deps)
    next.start()
    await flush()

    const [news] = repo.findingsOfDate(DAY)
    expect(repo.getBrief(DAY)).toMatchObject({ findingIds: [news!.id], quietProductIds: [], skipped: [] })
    expect(events.filter(e => e.startsWith('brief '))).toEqual(['brief 2026-11-25', 'brief 2026-11-26'])
    expect(calls.runDailyProduct.filter(c => c.date === DAY).map(c => c.productId)).toEqual(['p1', 'p2']) // nothing more for the 25th
    expect(calls.runDailyProduct.filter(c => c.date === '2026-11-26').map(c => c.productId)).toEqual(['p1', 'p2', 'p3']) // today as usual
    expect(repo.getSetting(LAST_COMPLETED)).toBe('2026-11-26')

    const written = repo.getBrief(DAY)!.updatedAt
    clock.set('2026-11-26T10:00')
    next.start() // a brief once written is not written again
    await flush()
    next.stop()
    expect(repo.getBrief(DAY)!.updatedAt).toBe(written)
    expect(events.filter(e => e === 'brief 2026-11-25')).toHaveLength(1)
  })

  it('runs today once and re-arms for tomorrow when the timer fires a moment early', async () => {
    scheduler.start()
    clock.early(1) // the timer for 08:00 fires at 07:59:59.999
    clock.set('2026-11-25T08:00:00.500')
    await flush()

    expect(calls.runDailyProduct).toEqual([{ productId: 'p1', date: DAY }, { productId: 'p2', date: DAY }, { productId: 'p3', date: DAY }])
    expect(clock.pending()).toEqual([local('2026-11-26T08:00')])
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)

    clock.set('2026-11-26T08:00')
    await flush()
    expect(calls.runDailyProduct.slice(3).map(c => c.date)).toEqual(['2026-11-26', '2026-11-26', '2026-11-26'])
    expect(clock.pending()).toEqual([local('2026-11-27T08:00')])
  })

  it('runs the right day when a midnight timer fires a moment early', async () => {
    settings.runTime = '00:00'
    repo.setSetting(LAST_COMPLETED, DAY)
    clock.set('2026-11-25T23:00')
    scheduler.start()
    expect(clock.pending()).toEqual([local('2026-11-26T00:00')])

    clock.early(1) // fires at 23:59:59.999 on the 25th, which is already done
    clock.set('2026-11-26T00:00:00.500')
    await flush()

    expect(calls.runDailyProduct.map(c => c.date)).toEqual(['2026-11-26', '2026-11-26', '2026-11-26'])
    expect(clock.pending()).toEqual([local('2026-11-27T00:00')])
  })

  it('reads the run time when it arms the timer, and falls back to 08:00 on one it cannot read', async () => {
    settings.runTime = '21:30'
    scheduler.start()
    expect(clock.pending()).toEqual([local('2026-11-25T21:30')])

    settings.runTime = '24:00'
    scheduler.start()
    expect(clock.pending()).toEqual([local('2026-11-25T08:00')])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('24:00'))
  })

  // ---- a change of the run time while Outpost runs (checked every minute, Ruling 32) ----

  it('runs today at a new run time two minutes ahead, within a minute of the change', async () => {
    repo.setSetting(LAST_COMPLETED, '2026-11-24')
    scheduler.start()
    expect(clock.pending()).toEqual([local('2026-11-25T08:00')])

    clock.set('2026-11-25T07:00:30')
    settings.runTime = '07:02'
    expect(clock.pending()).toEqual([local('2026-11-25T08:00')]) // nothing looked yet
    clock.set('2026-11-25T07:01') // the next check
    expect(clock.pending()).toEqual([local('2026-11-25T07:02')]) // the old timer is gone, the new one is set
    await flush()
    expect(calls.runDailyProduct).toEqual([])

    clock.set('2026-11-25T07:02')
    await flush()
    expect(dailyIds()).toEqual(['p1', 'p2', 'p3'])
    expect(calls.runDailyProduct.every(c => c.date === DAY)).toBe(true)
    expect(clock.pending()).toEqual([local('2026-11-26T07:02')]) // and tomorrow at the new time

    // The old 08:00 does not run the day again.
    clock.set('2026-11-25T08:05')
    await flush()
    expect(calls.runDailyProduct).toHaveLength(trackedCount)
  })

  it('runs once, now, when the new run time is already past today and today has not run', async () => {
    repo.setSetting(LAST_COMPLETED, '2026-11-24')
    scheduler.start()
    clock.set('2026-11-25T07:10')
    settings.runTime = '07:05'
    clock.set('2026-11-25T07:11') // the next check
    await flush()
    expect(dailyIds()).toEqual(['p1', 'p2', 'p3'])
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
    expect(clock.pending()).toEqual([local('2026-11-26T07:05')])

    // Never a second run the same day: another change to a past time, and the checks that follow, start nothing.
    settings.runTime = '07:06'
    clock.set('2026-11-25T07:13')
    settings.runTime = '07:00'
    clock.set('2026-11-25T23:00')
    await flush()
    expect(calls.runDailyProduct).toHaveLength(trackedCount)
    expect(clock.pending()).toEqual([local('2026-11-26T07:00')])
  })

  it('joins the day already running instead of starting another when the run time moves back', async () => {
    holds.p1 = gate()
    scheduler.start()
    clock.set('2026-11-25T08:00')
    await flush()
    expect(dailyIds()).toContain('p1') // the day is running, held at p1
    settings.runTime = '07:30'
    clock.set('2026-11-25T08:01')
    await flush()
    holds.p1!.open()
    await flush()
    expect(dailyIds()).toEqual(['p1', 'p2', 'p3']) // each once
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
  })

  it('waits for tomorrow at the new time when today has already completed', async () => {
    scheduler.start()
    clock.set('2026-11-25T08:00')
    await flush()
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
    expect(calls.runDailyProduct).toHaveLength(trackedCount)

    // Later, still today: the time moves to a later hour (today's moment would still lie ahead) and to an earlier one.
    clock.set('2026-11-25T09:00')
    settings.runTime = '10:00'
    clock.set('2026-11-25T09:01')
    expect(clock.pending()).toEqual([local('2026-11-26T10:00')])
    settings.runTime = '07:00'
    clock.set('2026-11-25T09:02')
    expect(clock.pending()).toEqual([local('2026-11-26T07:00')])
    clock.set('2026-11-25T23:59')
    await flush()
    expect(calls.runDailyProduct).toHaveLength(trackedCount) // nothing ran today again

    clock.set('2026-11-26T07:00')
    await flush()
    expect(calls.runDailyProduct.slice(trackedCount).map(c => c.date)).toEqual(['2026-11-26', '2026-11-26', '2026-11-26'])
  })

  it('leaves the timer alone while the run time is unchanged, and says once when the new one cannot be read', async () => {
    scheduler.start()
    const timer = clock.pending()
    clock.set('2026-11-25T07:05')
    expect(clock.pending()).toEqual(timer)

    settings.runTime = '24:00' // not HH:MM: 08:00 stands, as at the start
    clock.set('2026-11-25T07:08')
    expect(clock.pending()).toEqual([local('2026-11-25T08:00')])
    expect(log.mock.calls.filter(([message]) => message.includes('24:00'))).toHaveLength(0) // the same time as armed: nothing to report
    settings.runTime = '21:30'
    clock.set('2026-11-25T07:09')
    expect(clock.pending()).toEqual([local('2026-11-25T21:30')])
    settings.runTime = '99:99'
    clock.set('2026-11-25T07:12') // three checks
    expect(clock.pending()).toEqual([local('2026-11-25T08:00')])
    expect(log.mock.calls.filter(([message]) => message.includes('99:99'))).toHaveLength(1)
  })

  it('writes no brief and does not count the day when nothing is tracked yet, so products tracked later still run that day', async () => {
    db.prepare('DELETE FROM track_products').run() // a fresh install: nothing tracked yet
    clock.set('2026-11-25T09:00')
    scheduler.start() // past 08:00: today is caught up at once, with nothing to run
    await flush()
    expect(calls.runDailyProduct).toEqual([])
    expect(repo.getBrief(DAY)).toBeNull() // no 「今天没有值得看的变化」 for a day nothing was looked at
    expect(repo.getSetting(LAST_COMPLETED)).toBeUndefined()

    repo.linkProduct(trackId, 'p1') // the user picks a product; it is tracked once its baseline is through
    settings.runTime = '09:02' // and moves the run time two minutes ahead
    clock.set('2026-11-25T09:01')
    expect(clock.pending()).toEqual([local('2026-11-25T09:02')])
    clock.set('2026-11-25T09:02')
    await flush()
    expect(dailyIds()).toEqual(['p1'])
    expect(repo.getBrief(DAY)!.quietProductIds).toEqual(['p1'])
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
  })

  it('still re-baselines products stuck in 建档中 on a day with nothing tracked, once that day', async () => {
    db.prepare('DELETE FROM track_products').run()
    addProduct('p4', 'Zed', 'baselining', false) // its baseline failed yesterday
    deps.rebaseline = async ids => { calls.rebaseline.push(ids); for (const id of ids) recordBaseline(id, 'failed') }
    scheduler = new Scheduler(deps)
    clock.set('2026-11-25T09:00')
    scheduler.start()
    await flush()
    expect(calls.rebaseline).toEqual([['p4']])
    expect(repo.getBrief(DAY)).toBeNull()
    expect(repo.getSetting(LAST_COMPLETED)).toBeUndefined()

    scheduler.stop()
    clock.set('2026-11-25T11:00')
    const next = new Scheduler(deps) // the desktop app is opened again the same day: the day runs again, Zed is not baselined again
    next.start()
    await flush()
    next.stop()
    expect(calls.rebaseline).toEqual([['p4']])

    clock.set('2026-11-26T09:00')
    const tomorrow = new Scheduler(deps)
    tomorrow.start()
    await flush()
    tomorrow.stop()
    expect(calls.rebaseline).toEqual([['p4'], ['p4']]) // the next day it is tried again
  })

  it('baselines a stuck product again the same day when its baseline was cut short by a stop', async () => {
    db.prepare('DELETE FROM track_products').run()
    addProduct('p4', 'Zed', 'baselining', false)
    const cut = repo.createRun({ kind: 'baseline', date: DAY, trackId: null, productId: 'p4' })
    repo.updateRun(cut.id, { status: 'failed', startedAt: local('2026-11-25T08:00').toISOString(), endedAt: local('2026-11-25T08:05').toISOString(), error: STOPPED_ERROR })
    clock.set('2026-11-25T09:00')
    scheduler.start()
    await flush()
    expect(calls.rebaseline).toEqual([['p4']])
  })

  it('stops looking once stopped', async () => {
    repo.setSetting(LAST_COMPLETED, '2026-11-24')
    scheduler.start()
    scheduler.stop()
    settings.runTime = '07:02'
    clock.set('2026-11-25T07:05')
    await flush()
    expect(clock.pending()).toEqual([])
    expect(calls.runDailyProduct).toEqual([])
  })

  it('stops: no timer left, and a timer that still fires runs nothing', async () => {
    scheduler.start()
    scheduler.stop()
    expect(clock.pending()).toEqual([])
    clock.set('2026-11-26T09:00')
    await flush()
    expect(calls.runDailyProduct).toEqual([])
  })
})

describe('Scheduler: the day', () => {
  it('synthesizes as soon as every product is done, and only then marks the day complete and archives', async () => {
    plays.p1 = [{ findings: [{ headline: 'Cursor 后台 Agent 正式上线' }] }]

    await scheduler.runDay(DAY)

    const brief = repo.getBrief(DAY)!
    expect(brief.gist).toBe('今天 Cursor 有一条重要更新。')
    expect(brief.quietProductIds).toEqual(['p2', 'p3'])
    expect(repo.runsOfDate(DAY, 'synthesize')).toMatchObject([{ status: 'done', date: DAY }])
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
    expect(calls.archiveOld).toEqual([local('2026-11-25T07:00')])
    expect(clock.pending()).toEqual([]) // the cutoff timer was cancelled
    // The maps are drawn from the dossiers as the day left them: after the brief, before old sessions are archived (M2.1).
    // Then the weekly suggestions of the tracks due for them (M2.2).
    expect(events.slice(events.indexOf(`brief ${DAY}`))).toEqual([`brief ${DAY}`, `maps ${DAY}`, `weekly ${DAY}`, 'archive'])
  })

  it('leaves the day complete when the maps cannot be drawn, and says so in the log (M2.1)', async () => {
    mapsFail = true
    await scheduler.runDay(DAY)
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
    expect(calls.archiveOld).toHaveLength(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('drawing the maps failed: model down'))
  })

  it('synthesizes at the 2-hour cutoff and appends late products marked 迟到', async () => {
    plays.p1 = [{ findings: [{ headline: 'Cursor 后台 Agent 正式上线' }] }]
    plays.p2 = [{ findings: [{ headline: 'Windsurf 发布 Wave 9', importance: 'notable' }] }]
    holds.p2 = gate()
    holds.p3 = gate()
    clock.set('2026-11-25T08:00')

    const day = scheduler.runDay(DAY)
    await flush()
    expect(repo.getBrief(DAY)).toBeNull() // Windsurf and Cline are still running
    expect(clock.pending()).toEqual([local('2026-11-25T10:00')])

    clock.set('2026-11-25T10:00')
    await flush()
    const atCutoff = repo.getBrief(DAY)!
    const [cursorNews] = repo.findingsOfDate(DAY)
    expect(atCutoff.findingIds).toEqual([cursorNews!.id])
    expect(atCutoff.quietProductIds).toEqual([]) // the two still running are not called quiet
    expect(complete).toHaveBeenCalledOnce()
    expect(repo.getSetting(LAST_COMPLETED)).toBeUndefined() // not over yet
    expect(calls.archiveOld).toEqual([])

    clock.set('2026-11-25T10:40')
    holds.p2!.open()
    await flush()
    const withWindsurf = repo.getBrief(DAY)!
    const windsurfNews = repo.findingsOfDate(DAY).find(f => f.productId === 'p2')!
    expect(windsurfNews.late).toBe(true) // 迟到
    expect(repo.getFinding(cursorNews!.id)!.late).toBe(false)
    expect(withWindsurf.findingIds).toEqual([cursorNews!.id, windsurfNews.id])
    expect(withWindsurf.gist).toBe(atCutoff.gist)
    expect(withWindsurf.createdAt).toBe(atCutoff.createdAt)
    expect(complete).toHaveBeenCalledOnce()

    holds.p3!.open()
    await day
    expect(repo.getBrief(DAY)!.quietProductIds).toEqual(['p3'])
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
    expect(calls.archiveOld).toHaveLength(1)
  })

  it('regenerates the no-news gist when a late product brings news', async () => {
    plays.p3 = [{ findings: [{ headline: 'Cline 发布 4.0' }] }]
    holds.p3 = gate()
    clock.set('2026-11-25T08:00')
    const day = scheduler.runDay(DAY)
    await flush()
    clock.set('2026-11-25T10:00')
    await flush()
    expect(repo.getBrief(DAY)!.gist).toBe(NO_NEWS_GIST)
    expect(complete).not.toHaveBeenCalled()

    holds.p3!.open()
    await day

    expect(complete).toHaveBeenCalledOnce()
    expect(repo.getBrief(DAY)!.gist).toBe('今天 Cursor 有一条重要更新。')
    expect(repo.findingsOfDate(DAY)).toMatchObject([{ headline: 'Cline 发布 4.0', late: true }])
  })

  it('retries a failed product once, then names it 未能更新', async () => {
    plays.p2 = [{ status: 'failed', error: '会话出错' }, { status: 'failed', error: '模型返回了无法解析的内容' }]
    plays.p3 = [{ status: 'failed', error: '会话出错' }, {}]

    await scheduler.runDay(DAY)

    expect(dailyIds().filter(id => id === 'p1')).toHaveLength(1)
    expect(dailyIds().filter(id => id === 'p2')).toHaveLength(2)
    expect(dailyIds().filter(id => id === 'p3')).toHaveLength(2)
    const brief = repo.getBrief(DAY)!
    expect(brief.skipped).toEqual([{ productId: 'p2', reason: '模型返回了无法解析的内容', failed: true }])
    expect(brief.quietProductIds).toEqual(['p1', 'p3'])
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY) // the day is over: two failures is as far as it goes

    await scheduler.runDay(DAY) // run again (a restart): nothing is tried a third time
    expect(calls.runDailyProduct).toHaveLength(5)
  })

  it('does not try again a product the user paused while its failed run was going', async () => {
    holds.p2 = gate()
    plays.p2 = [{ status: 'failed', error: '会话出错' }, {}]
    const day = scheduler.runDay(DAY)
    await vi.waitFor(() => { expect(dailyIds()).toContain('p2') })
    repo.setProductStatus('p2', 'paused') // 暂停 while it runs: its run ends as it will, and that is the last of it today
    holds.p2!.open()
    await day

    expect(dailyIds().filter(id => id === 'p2')).toHaveLength(1)
    expect(repo.getBrief(DAY)!.skipped).toEqual([{ productId: 'p2', reason: '会话出错', failed: true }])
  })

  it('gives a product that failed before a restart one more try, not two', async () => {
    seedRun('p1', 'failed', '会话出错')
    seedRun('p2', 'done')
    seedRun('p3', 'skipped', '今日总预算已用完')
    plays.p1 = [{ status: 'failed', error: '会话出错' }]

    await scheduler.runDay(DAY)

    expect(dailyIds()).toEqual(['p1'])
  })

  it('treats a stop as an interruption: no brief, the day not complete, and the product runs again on the next start', async () => {
    settings.maxParallel = 1
    seedRun('p2', 'failed', '会话出错') // one real failure earlier today: one more try left
    plays.p2 = [{ status: 'failed', error: STOPPED_ERROR }]

    await scheduler.runDay(DAY)

    expect(dailyIds()).toEqual(['p1', 'p2']) // nothing started after the stop
    expect(repo.getBrief(DAY)).toBeNull()
    expect(repo.getSetting(LAST_COMPLETED)).toBeUndefined()
    expect(calls.archiveOld).toEqual([])

    clock.set('2026-11-25T09:00')
    const next = new Scheduler(deps) // the next start
    next.start()
    await flush()
    next.stop()
    expect(dailyIds()).toEqual(['p1', 'p2', 'p2', 'p3']) // an interruption is not counted as a failure
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
  })

  it('starts nothing more once the scheduler is stopped', async () => {
    settings.maxParallel = 1
    holds.p1 = gate()
    const day = scheduler.runDay(DAY)
    await flush()
    scheduler.stop()
    holds.p1!.open()
    await day

    expect(dailyIds()).toEqual(['p1'])
    expect(repo.getBrief(DAY)).toBeNull()
    expect(repo.getSetting(LAST_COMPLETED)).toBeUndefined()
  })

  it('skips a product whose own budget is spent without starting it, and names it', async () => {
    repo.upsertProduct({ id: 'p2', name: 'Windsurf', company: 'Windsurf Inc', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: 0 })

    await scheduler.runDay(DAY)

    expect(dailyIds()).toEqual(['p1', 'p3'])
    expect(repo.runsOfDate(DAY, 'daily').find(r => r.productId === 'p2')).toMatchObject({ status: 'skipped', error: '该产品今日预算已用完' })
    expect(repo.getBrief(DAY)!.skipped).toEqual([{ productId: 'p2', reason: '该产品今日预算已用完' }])
  })

  it('starts the daily runs of products researched on a local model even when the budget is used up', async () => {
    settings.model = { provider: 'ollama', model: 'qwen3:8b' }
    settings.billingFor = model => model?.provider === 'ollama' ? 'local' : 'metered'
    const spent = repo.createRun({ kind: 'verify', date: DAY, trackId: null, productId: 'p1' }) // a check on DeepSeek spent the day's budget
    repo.updateRun(spent.id, { status: 'done', costYuan: 20 })
    repo.upsertProduct({ id: 'p2', name: 'Windsurf', company: 'Windsurf Inc', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: 0 })

    await scheduler.runDay(DAY)

    expect(dailyIds()).toEqual(['p1', 'p2', 'p3'])
    expect(repo.runsOfDate(DAY, 'daily').filter(r => r.status === 'skipped')).toEqual([])
    expect(repo.getBrief(DAY)!.skipped).toEqual([])
  })

  it('re-baselines stuck products, and fills in missing dimensions before a product\'s daily run', async () => {
    addProduct('p4', 'Zed', 'baselining') // its baseline failed some earlier day
    addProduct('p5', 'Trae', 'paused', false) // not tracked: left alone
    const filled = gate()
    // Windsurf has no card for 定位 (its baseline card was rejected by the check).
    db.prepare("DELETE FROM card_versions WHERE product_id = 'p2'").run()
    deps.rebaseline = async ids => {
      calls.rebaseline.push(ids)
      events.push(`rebaseline ${ids.join(',')}`)
      if (ids.includes('p2')) await filled.promise
    }
    scheduler = new Scheduler(deps)

    const day = scheduler.runDay(DAY)
    await flush()
    expect(calls.rebaseline).toEqual([['p4'], ['p2']])
    expect(dailyIds()).toEqual(['p1', 'p3']) // Windsurf waits for its missing card

    filled.open()
    await day
    expect(dailyIds()).toEqual(['p1', 'p3', 'p2'])
    expect(events.indexOf('rebaseline p2')).toBeLessThan(events.indexOf('daily p2'))
    expect(repo.getBrief(DAY)!.quietProductIds).toEqual(['p1', 'p2', 'p3']) // Zed is not tracked yet: not in the brief
  })

  it('fills in a tracked product\'s missing dimensions at most once in 7 days', async () => {
    db.prepare("DELETE FROM card_versions WHERE product_id = 'p2'").run() // Windsurf's 定位 card was rejected by the check
    const toppedUp: string[] = []
    deps.rebaseline = async ids => { // the baseline runs, and fails again: the dimension stays without a card
      for (const id of ids) {
        toppedUp.push(`${id} ${localDate(clock.clock.now())}`)
        recordBaseline(id, 'failed')
      }
    }
    scheduler = new Scheduler(deps)

    const days = ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']
    for (const day of days) {
      clock.set(`${day}T08:00`)
      await scheduler.runDay(day)
    }

    expect(toppedUp).toEqual(['p2 2026-11-25', 'p2 2026-12-02']) // day 1, then not on days 2–7, then day 8
    expect(calls.runDailyProduct.filter(c => c.productId === 'p2').map(c => c.date)).toEqual(days) // its daily update goes on every day
  })

  it('tries the missing dimensions again the next day when the budget kept the baseline from starting', async () => {
    db.prepare("DELETE FROM card_versions WHERE product_id = 'p2'").run()
    deps.rebaseline = async ids => { calls.rebaseline.push(ids); for (const id of ids) recordBaseline(id, 'skipped') }
    scheduler = new Scheduler(deps)

    await scheduler.runDay(DAY)
    clock.set('2026-11-26T08:00')
    await scheduler.runDay('2026-11-26')

    expect(calls.rebaseline).toEqual([['p2'], ['p2']])
  })

  it('retries a product stuck in 建档中 on every run day', async () => {
    addProduct('p4', 'Zed', 'baselining', false)
    deps.rebaseline = async ids => { calls.rebaseline.push(ids); for (const id of ids) recordBaseline(id, 'failed') }
    scheduler = new Scheduler(deps)

    for (const day of ['2026-11-25', '2026-11-26', '2026-11-27']) {
      clock.set(`${day}T08:00`)
      await scheduler.runDay(day)
    }

    expect(calls.rebaseline).toEqual([['p4'], ['p4'], ['p4']])
  })

  it('does not mark the day complete when it is stopped while the day\'s brief is being written', async () => {
    const writing = gate()
    deps.synthesize = async date => { events.push(`brief ${date}`); await writing.promise; return synthesizeBrief({ repo, model: { complete }, clock: clock.clock, settings: () => settings }, date) }
    scheduler = new Scheduler(deps)
    const day = scheduler.runDay(DAY)
    await vi.waitFor(() => { expect(events).toContain(`brief ${DAY}`) })
    scheduler.stop() // quitting while the gist is asked for: what gets written is only a stand-in
    writing.open()
    await day

    expect(repo.getBrief(DAY)).not.toBeNull()
    expect(repo.getSetting(LAST_COMPLETED)).toBeUndefined() // the next start writes the brief again and only then completes the day
    expect(calls.archiveOld).toEqual([])
  })

  it('does not mark the day complete when the brief could not be written', async () => {
    deps.synthesize = async () => { throw new Error('磁盘已满') }
    scheduler = new Scheduler(deps)

    await scheduler.runDay(DAY)

    expect(repo.getSetting(LAST_COMPLETED)).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('磁盘已满'))
    expect(calls.archiveOld).toHaveLength(1) // old sessions are archived all the same
  })

  it('never moves the completed day back', async () => {
    repo.setSetting(LAST_COMPLETED, DAY)
    await scheduler.runDay('2026-11-24')
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
  })

  it('logs a product whose run threw, and goes on with the others', async () => {
    deps.runDailyProduct = async (productId, date) => {
      if (productId === 'p2') throw new Error('Unknown product p2')
      calls.runDailyProduct.push({ productId, date })
      const run = seedRun(productId, 'done', null, date)
      return run
    }
    scheduler = new Scheduler(deps)

    await scheduler.runDay(DAY)

    expect(dailyIds()).toEqual(['p1', 'p3'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Unknown product p2'))
    expect(repo.getBrief(DAY)).not.toBeNull()
  })
})

describe('Scheduler: 立即更新', () => {
  it('runs the product and writes today\'s brief when there is none yet', async () => {
    plays.p2 = [{ findings: [{ headline: 'Windsurf 发布 Wave 9' }] }]

    const run = await scheduler.runProductNow('p2')

    expect(run).toMatchObject({ productId: 'p2', date: DAY, status: 'done' })
    expect(dailyIds()).toEqual(['p2'])
    const brief = repo.getBrief(DAY)!
    expect(brief.findingIds).toHaveLength(1)
    expect(repo.findingsOfDate(DAY)[0]!.late).toBe(false)
  })

  it('adds the product to today\'s brief when there is one', async () => {
    await scheduler.runDay(DAY)
    plays.p2 = [{ findings: [{ headline: 'Windsurf 发布 Wave 9' }] }]

    await scheduler.runProductNow('p2')

    const news = repo.findingsOfDate(DAY).find(f => f.productId === 'p2')!
    expect(repo.getBrief(DAY)!.findingIds).toEqual([news.id])
    expect(news.late).toBe(true)
  })

  it('re-baselines a product stuck in 建档中 instead of updating it', async () => {
    addProduct('p4', 'Zed', 'baselining', false)

    expect(await scheduler.runProductNow('p4')).toBeNull()

    expect(calls.rebaseline).toEqual([['p4']])
    expect(calls.runDailyProduct).toEqual([])
  })

  it('joins a top-up in flight: one baseline, and the daily run starts only after it', async () => {
    db.prepare("DELETE FROM card_versions WHERE product_id = 'p2'").run()
    const filled = gate()
    deps.rebaseline = async ids => { // as the baseline job leaves its run: started at once, ended when it is over
      calls.rebaseline.push(ids)
      const now = () => clock.clock.now().toISOString()
      const run = repo.createRun({ kind: 'baseline', date: DAY, trackId: null, productId: ids[0]! })
      repo.updateRun(run.id, { status: 'running', startedAt: now() })
      await filled.promise
      repo.updateRun(run.id, { status: 'done', endedAt: now() })
      events.push(`rebaseline ${ids.join(',')} over`)
    }
    scheduler = new Scheduler(deps)
    const day = scheduler.runDay(DAY)
    await flush()
    expect(calls.rebaseline).toEqual([['p2']])

    const now = scheduler.runProductNow('p2') // 立即更新 while the day fills in Windsurf's missing card
    await flush()
    expect(calls.rebaseline).toEqual([['p2']]) // joined, not a second baseline
    expect(dailyIds()).toEqual(['p1', 'p3']) // nothing runs beside the baseline

    filled.open()
    const [run] = await Promise.all([now, day])
    expect(dailyIds()).toEqual(['p1', 'p3', 'p2']) // once
    expect(events.indexOf('rebaseline p2 over')).toBeLessThan(events.indexOf('daily p2'))
    expect(run).toMatchObject({ productId: 'p2', status: 'done' })
  })

  it('does not baseline a product again in the day after 立即更新 topped it up', async () => {
    db.prepare("DELETE FROM card_versions WHERE product_id = 'p2'").run()
    deps.rebaseline = async ids => { calls.rebaseline.push(ids); for (const id of ids) recordBaseline(id, 'done') }
    scheduler = new Scheduler(deps)
    settings.maxParallel = 1
    holds.p1 = gate() // the day is busy with Cursor; Windsurf waits in line
    holds.p2 = gate()
    const day = scheduler.runDay(DAY)
    await flush()

    const now = scheduler.runProductNow('p2') // tops Windsurf up, then starts its update
    await flush()
    expect(calls.rebaseline).toEqual([['p2']])
    holds.p1!.open() // the day reaches Windsurf while 立即更新 is still updating it
    await flush()
    holds.p2!.open()
    await Promise.all([now, day])

    expect(calls.rebaseline).toEqual([['p2']])
    expect(dailyIds()).toEqual(['p1', 'p2', 'p3'])
  })

  it('queues 立即更新\'s brief behind the day\'s writes, so a slow gist cannot overwrite a fuller brief', async () => {
    const answers: ReturnType<typeof gate>[] = []
    complete.mockImplementation(async () => {
      const answer = gate()
      answers.push(answer)
      await answer.promise
      return { text: '今天四条更新。', usage: usage() }
    })
    plays.p1 = [{ findings: [{ headline: 'Cursor 后台 Agent 正式上线' }] }, { findings: [{ headline: 'Cursor 团队版涨价' }] }]
    plays.p2 = [{ findings: [{ headline: 'Windsurf 发布 Wave 9' }] }]
    plays.p3 = [{ findings: [{ headline: 'Cline 发布 4.0' }] }]
    holds.p2 = gate()
    holds.p3 = gate()
    clock.set('2026-11-25T08:00')
    const day = scheduler.runDay(DAY)
    await flush()

    clock.set('2026-11-25T08:30')
    const now = scheduler.runProductNow('p1') // Cursor again; today has no brief yet, so this one writes it
    await flush()
    expect(answers).toHaveLength(1)

    holds.p2!.open()
    holds.p3!.open()
    await flush()
    expect(answers).toHaveLength(1) // the day's own brief waits for that write instead of racing it

    answers[0]!.open()
    await flush()
    expect(answers).toHaveLength(2)
    answers[1]!.open()
    await Promise.all([now, day])

    const headlines = repo.getBrief(DAY)!.findingIds.map(id => repo.getFinding(id)!.headline)
    expect(headlines.sort()).toEqual(['Cline 发布 4.0', 'Cursor 后台 Agent 正式上线', 'Cursor 团队版涨价', 'Windsurf 发布 Wave 9'].sort())
  })

  it('adds 立即更新\'s news to the day\'s brief when the day\'s gist is still being written', async () => {
    const held = gate()
    complete.mockImplementation(async () => { await held.promise; return { text: '今天一条更新。', usage: usage() } })
    plays.p1 = [{ findings: [{ headline: 'Cursor 后台 Agent 正式上线' }] }, { findings: [{ headline: 'Cursor 团队版涨价' }] }]
    const day = scheduler.runDay(DAY)
    await flush()
    expect(complete).toHaveBeenCalledOnce() // the day's gist

    const now = scheduler.runProductNow('p1')
    await flush()
    held.open()
    await Promise.all([now, day])

    const brief = repo.getBrief(DAY)!
    expect(brief.findingIds.map(id => repo.getFinding(id)!.headline)).toEqual(['Cursor 后台 Agent 正式上线', 'Cursor 团队版涨价'])
    expect(brief.gist).toBe('今天一条更新。')
    expect(complete).toHaveBeenCalledOnce()
  })

  it('does not run a product again that 立即更新 finished while it waited in the day\'s line', async () => {
    settings.maxParallel = 1
    holds.p1 = gate() // the day holds its only place with Cursor; Windsurf and Cline wait in line
    const day = scheduler.runDay(DAY)
    await flush()

    await scheduler.runProductNow('p3') // Cline is updated now
    holds.p1!.open()
    await day

    expect(dailyIds()).toEqual(['p1', 'p3', 'p2']) // not Cline a second time
    expect(repo.getSetting(LAST_COMPLETED)).toBe(DAY)
  })

  it('waits for the product\'s run in flight rather than starting a second one beside it', async () => {
    holds.p1 = gate()
    const day = scheduler.runDay(DAY)
    await flush()

    const now = scheduler.runProductNow('p1')
    holds.p1!.open()
    const [run] = await Promise.all([now, day])

    expect(dailyIds()).toEqual(['p1', 'p2', 'p3'])
    expect(run).toMatchObject({ productId: 'p1', status: 'done' })
  })
})

describe('Scheduler: work started from outside the day', () => {
  it('updates a product only after a baseline started through it, which it joins rather than doubles', async () => {
    const filled = gate()
    deps.rebaseline = async ids => {
      calls.rebaseline.push(ids)
      events.push(`rebaseline ${ids.join(',')}`)
      await filled.promise
      events.push(`rebaseline ${ids.join(',')} over`)
    }
    scheduler = new Scheduler(deps)
    // Windsurf has every card, so the day sees nothing to fill in; a baseline asked for elsewhere (a new track) still runs.
    const started = scheduler.baseline(['p2', 'p2'])
    const again = scheduler.baseline(['p2'])
    const now = scheduler.runProductNow('p2')
    const day = scheduler.runDay(DAY)
    await flush()
    expect(calls.rebaseline).toEqual([['p2']])
    expect(dailyIds()).toEqual(['p1', 'p3']) // nothing runs on Windsurf beside its baseline

    filled.open()
    await Promise.all([started, again, now, day])
    expect(dailyIds()).toEqual(['p1', 'p3', 'p2']) // once
    expect(events.indexOf('rebaseline p2 over')).toBeLessThan(events.indexOf('daily p2'))
  })

  it('baselines each product on its own, so one product\'s update does not wait for another\'s baseline', async () => {
    const slow = gate()
    deps.rebaseline = async ids => { calls.rebaseline.push(ids); if (ids.includes('p1')) await slow.promise }
    scheduler = new Scheduler(deps)
    const both = scheduler.baseline(['p1', 'p2'])
    expect(calls.rebaseline).toEqual([['p1'], ['p2']])
    await scheduler.runProductNow('p2') // Windsurf's baseline is over: its update goes ahead while Cursor's still runs
    expect(dailyIds()).toEqual(['p2'])
    slow.open()
    await both
  })

  it('starts a baseline asked for while the product\'s daily run is in flight only once that run is over', async () => {
    holds.p1 = gate()
    const now = scheduler.runProductNow('p1')
    await flush()
    const baseline = scheduler.baseline(['p1'])
    await flush()
    expect(calls.rebaseline).toEqual([]) // not beside the running update
    holds.p1!.open()
    await Promise.all([now, baseline])
    expect(calls.rebaseline).toEqual([['p1']])
    expect(events.indexOf('daily p1 done')).toBeLessThan(events.indexOf('rebaseline p1'))
  })

  it('rewrites a day\'s brief through the same queue as the day\'s own writes, and not once stopped', async () => {
    plays.p1 = [{ findings: [{ headline: 'Cursor 后台 Agent 正式上线' }] }]
    await scheduler.runDay(DAY)
    complete.mockResolvedValueOnce({ text: '重写后的一句话。', usage: usage() })
    expect(await scheduler.rewriteBrief(DAY)).toBe(true)
    expect(repo.getBrief(DAY)!.gist).toBe('重写后的一句话。')

    scheduler.stop()
    expect(await scheduler.rewriteBrief(DAY)).toBe(false)
  })

  it('idle resolves only once the day in flight, its products and its brief are over', async () => {
    holds.p1 = gate()
    const day = scheduler.runDay(DAY)
    await flush()
    const idle = vi.fn()
    void scheduler.idle().then(idle)
    await flush()
    expect(idle).not.toHaveBeenCalled()

    holds.p1!.open()
    await day
    await vi.waitFor(() => { expect(idle).toHaveBeenCalled() })
    expect(repo.getBrief(DAY)).not.toBeNull()
  })

  it('idle resolves at once when nothing runs', async () => {
    await expect(scheduler.idle()).resolves.toBeUndefined()
  })
})

describe('Scheduler: 重试 of a failed check', () => {
  const CHECK_FAILED = '核查没有完成：模型返回了无法解析的内容'

  it('checks the product again without a daily session; its daily run then counts as done and the brief takes it', async () => {
    seedRun('p1', 'failed', CHECK_FAILED) // its research went through, its check did not
    plays.p1 = [{ findings: [{ headline: 'Cursor 后台 Agent 正式上线' }] }]

    await scheduler.recheck('p1', DAY)

    expect(calls.verifyProduct).toEqual([{ productId: 'p1', date: DAY }])
    expect(calls.runDailyProduct).toEqual([])
    expect(repo.runsOfDate(DAY, 'daily')[0]).toMatchObject({ productId: 'p1', status: 'done', error: null })
    expect(repo.getBrief(DAY)!.quietProductIds).toEqual(['p1']) // looked at, no longer 「未能更新」

    await scheduler.runDay(DAY) // the day does not run Cursor again
    expect(dailyIds()).toEqual(['p2', 'p3'])
  })

  it('leaves the daily run failed when the check did not finish again', async () => {
    seedRun('p1', 'failed', CHECK_FAILED)
    deps.verifyProduct = async () => { throw new Error('核查失败') }
    scheduler = new Scheduler(deps)

    await scheduler.recheck('p1', DAY)

    expect(repo.runsOfDate(DAY, 'daily')[0]).toMatchObject({ status: 'failed', error: CHECK_FAILED })
    expect(repo.getBrief(DAY)).toBeNull()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('核查失败'))
  })

  it('never runs beside the product\'s daily run: it waits for it, and the day waits for the check', async () => {
    holds.p1 = gate()
    const day = scheduler.runDay(DAY)
    await flush()
    const check = scheduler.recheck('p1', DAY)
    await flush()
    expect(calls.verifyProduct).toEqual([]) // not beside the running update
    holds.p1!.open()
    await Promise.all([day, check])
    expect(events.indexOf('daily p1 done')).toBeLessThan(events.indexOf('check p1'))

    holds['check p2'] = gate()
    const second = scheduler.recheck('p2', DAY)
    await flush()
    const now = scheduler.runProductNow('p2')
    await flush()
    expect(dailyIds().filter(id => id === 'p2')).toHaveLength(1) // 立即更新 waits for the check
    holds['check p2']!.open()
    await Promise.all([second, now])
    expect(events.indexOf('check p2 done')).toBeLessThan(events.lastIndexOf('daily p2'))
  })

  it('never deadlocks with a top-up asked for while it waits: the top-up it waits for runs first, the one asked for later after it', async () => {
    db.prepare("DELETE FROM card_versions WHERE product_id = 'p2'").run() // Windsurf misses a card, and keeps missing it
    const filled = gate()
    let baselines = 0
    deps.rebaseline = async ids => {
      const n = ++baselines
      events.push(`rebaseline ${ids.join(',')} ${n}`)
      if (n === 1) await filled.promise
      events.push(`rebaseline ${ids.join(',')} ${n} over`)
    }
    scheduler = new Scheduler(deps)

    const first = scheduler.baseline(['p2']) // a baseline in flight
    const check = scheduler.recheck('p2', DAY) // waits for it
    const more = scheduler.topUpNow(['p2']) // joins it, then asks for what is still missing: after the check
    await flush()
    filled.open()
    await Promise.all([first, check, more])

    expect(events.filter(e => e.startsWith('rebaseline') || e.startsWith('check'))).toEqual([
      'rebaseline p2 1', 'rebaseline p2 1 over', 'check p2', 'check p2 done', 'rebaseline p2 2', 'rebaseline p2 2 over',
    ])
  })
})

describe('Scheduler: top-ups the user asked for', () => {
  /** A baseline that records its run (so the 7-day window sees it) and fills in nothing, like one whose card was rejected. */
  const failingBaseline = (log: string[]) => async (ids: Id[]) => {
    for (const id of ids) { log.push(`${id} ${localDate(clock.clock.now())}`); recordBaseline(id, 'failed') }
  }

  it('fills in missing cards at once whatever the 7-day window, which still holds for the automatic top-up the next day', async () => {
    db.prepare("DELETE FROM card_versions WHERE product_id = 'p2'").run()
    const toppedUp: string[] = []
    deps.rebaseline = failingBaseline(toppedUp)
    scheduler = new Scheduler(deps)
    clock.set('2026-11-25T08:00')
    await scheduler.runDay(DAY) // the day tops Windsurf up once: the window starts
    expect(toppedUp).toEqual(['p2 2026-11-25'])

    clock.set('2026-11-25T10:00') // the user adds a dimension to the track: no waiting a week
    await scheduler.topUpNow(['p2'])
    expect(toppedUp).toEqual(['p2 2026-11-25', 'p2 2026-11-25'])

    clock.set('2026-11-26T08:00')
    await scheduler.runDay('2026-11-26') // the next day's automatic top-up still waits out the 7 days
    expect(toppedUp).toEqual(['p2 2026-11-25', 'p2 2026-11-25'])
    expect(dailyIds().filter(id => id === 'p2')).toEqual(['p2', 'p2'])
  })

  it('leaves a product alone when it misses no card, or is neither tracked nor in 建档中', async () => {
    addProduct('p5', 'Cline Pro', 'paused', false)
    await scheduler.topUpNow(['p1', 'p5'])
    expect(calls.rebaseline).toEqual([])
  })

  it('joins the baseline of a product in 建档中 that the top-ups do not know of, then fills in what it was not asked for', async () => {
    addProduct('p4', 'Zed', 'baselining', false)
    const first = gate()
    const inFlight = new Map<Id, Promise<void>>() // as baselineProducts: a second request for a product joins the first
    deps.rebaseline = ids => {
      const id = ids[0]!
      const running = inFlight.get(id)
      if (running) return running
      calls.rebaseline.push(ids)
      events.push(`rebaseline ${id}`)
      const work = (async () => {
        if (calls.rebaseline.length === 1) await first.promise
        // Zed's baseline fills in 定位, the one dimension known when it started, and Zed is tracked from then on.
        if (!repo.latestCards(id).length) repo.addCardVersion({ productId: id, dimension: 'positioning', version: 1, summary: '编辑器', bullets: ['快'], body: '编辑器[1]', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-25T00:00:00.000Z' })
        repo.setProductStatus(id, 'tracking')
        events.push(`rebaseline ${id} over`)
      })().finally(() => { inFlight.delete(id) })
      inFlight.set(id, work)
      return work
    }
    scheduler = new Scheduler(deps)
    const stuck = scheduler.runProductNow('p4') // 立即更新 of a product in 建档中: its baseline, outside the top-ups
    await flush()
    repo.updateTrack(trackId, { dimensions: [{ key: 'positioning', label: '定位' }, { key: 'community', label: '社区' }] }) // the user adds 社区
    const forced = scheduler.topUpNow(['p4'])
    await flush()
    expect(calls.rebaseline).toEqual([['p4']]) // joined, not a second one beside it

    first.open()
    await Promise.all([stuck, forced])
    expect(calls.rebaseline).toEqual([['p4'], ['p4']]) // 社区 asked for after the first one
    expect(events.filter(e => e.startsWith('rebaseline p4'))).toEqual(['rebaseline p4', 'rebaseline p4 over', 'rebaseline p4', 'rebaseline p4 over'])
  })

  it('never runs beside a daily run in flight: it starts once that run is over', async () => {
    repo.updateTrack(trackId, { dimensions: [{ key: 'positioning', label: '定位' }, { key: 'business', label: '商业化' }] })
    repo.addCardVersion({ productId: 'p1', dimension: 'business', version: 1, summary: '订阅', bullets: ['按月'], body: '订阅[1]', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-20T00:00:00.000Z' })
    holds.p1 = gate()
    const now = scheduler.runProductNow('p1') // complete, so it goes straight to its daily run
    await flush()
    db.prepare("DELETE FROM card_versions WHERE product_id = 'p1' AND dimension = 'business'").run() // as if just added
    const forced = scheduler.topUpNow(['p1'])
    await flush()
    expect(calls.rebaseline).toEqual([])
    holds.p1!.open()
    await Promise.all([now, forced])
    expect(calls.rebaseline).toEqual([['p1']])
    expect(events.indexOf('daily p1 done')).toBeLessThan(events.indexOf('rebaseline p1'))
  })

  it('joins a top-up in flight, then fills in what that one was not asked for', async () => {
    db.prepare("DELETE FROM card_versions WHERE product_id = 'p2'").run()
    const first = gate()
    let running = 0
    let overlapped = false
    deps.rebaseline = async ids => {
      calls.rebaseline.push(ids)
      if (++running > 1) overlapped = true
      if (calls.rebaseline.length === 1) await first.promise
      running--
    }
    scheduler = new Scheduler(deps)
    const earlier = scheduler.baseline(['p2']) // asked for before the user added the dimension
    const forced = scheduler.topUpNow(['p2'])
    await flush()
    expect(calls.rebaseline).toEqual([['p2']]) // not a second one beside it

    first.open()
    await Promise.all([earlier, forced])
    expect(calls.rebaseline).toEqual([['p2'], ['p2']]) // the card is still missing: one more, after the first
    expect(overlapped).toBe(false)
  })

  it('starts nothing once the scheduler is stopped', async () => {
    db.prepare("DELETE FROM card_versions WHERE product_id = 'p2'").run()
    scheduler.stop()
    await scheduler.topUpNow(['p2'])
    expect(calls.rebaseline).toEqual([])
  })
})
