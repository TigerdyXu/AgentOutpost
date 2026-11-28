import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { Run, Track } from '../../src/core/types.ts'
import { weeklyDue, weeklyOffKey, weeklyState } from '../../src/host/jobs/weekly.ts'
import { openDb, type Db } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'

const TODAY = '2026-12-03'
let dir: string
let db: Db
let repo: Repo
let track: Track

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-weekly-'))
  db = openDb(join(dir, 'outpost.sqlite'))
  repo = new Repo(db, () => new Date('2026-12-03T02:00:00.000Z'))
  track = repo.createTrack({ name: 'Personal Agent', brief: '', dimensions: DEFAULT_DIMENSIONS, status: 'active' })
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const recommendation = (date: string, status: Run['status'], trackId = track.id) => {
  const run = repo.createRun({ kind: 'recommend', date, trackId, productId: null })
  repo.updateRun(run.id, { status })
  return run
}

describe('weekly suggestions (M2.2)', () => {
  it('are due seven days after the last recommendation that ran to its end', () => {
    recommendation('2026-11-26', 'done')
    expect(weeklyState(repo, track, TODAY)).toEqual({ on: true, last: '2026-11-26', next: TODAY, running: false, problem: null })
    // Once today's run is through, what is due now waits for tomorrow's (what the page says).
    expect(weeklyState(repo, track, TODAY, true).next).toBe('2026-12-04')
    expect(weeklyDue(repo, track, TODAY)).toBe(true)
    expect(weeklyState(repo, track, '2026-12-02')).toMatchObject({ next: TODAY })
    expect(weeklyDue(repo, track, '2026-12-02')).toBe(false)
  })

  it('count from the latest finished one, a 「再推荐一批」 too, and not from one skipped or failed', () => {
    recommendation('2026-11-26', 'done')
    recommendation('2026-11-29', 'done') // the user asked for another batch
    recommendation('2026-11-30', 'skipped')
    recommendation('2026-12-01', 'failed')
    expect(weeklyState(repo, track, TODAY)).toMatchObject({ last: '2026-11-29', next: '2026-12-06' })
  })

  it('are tried once a day while due: one that did not finish today is tried again tomorrow', () => {
    recommendation('2026-11-20', 'done')
    expect(weeklyDue(repo, track, TODAY)).toBe(true)
    const skipped = recommendation(TODAY, 'skipped') // the budget was spent
    repo.updateRun(skipped.id, { error: '今日总预算已用完' })
    expect(weeklyState(repo, track, TODAY)).toMatchObject({ next: '2026-12-04', problem: '今日总预算已用完' })
    expect(weeklyDue(repo, track, TODAY)).toBe(false)
    expect(weeklyDue(repo, track, '2026-12-04')).toBe(true)
    recommendation('2026-12-04', 'done')
    expect(weeklyState(repo, track, '2026-12-04').problem).toBeNull() // a finished one since: no problem to tell
  })

  it('wait for a recommendation that is running, and are due at once for a track with none finished yet', () => {
    expect(weeklyState(repo, track, TODAY)).toMatchObject({ last: null, next: TODAY })
    const running = repo.createRun({ kind: 'recommend', date: '2026-12-02', trackId: track.id, productId: null })
    repo.updateRun(running.id, { status: 'running' })
    expect(weeklyState(repo, track, TODAY)).toMatchObject({ running: true })
    expect(weeklyDue(repo, track, TODAY)).toBe(false)
  })

  it('are not due for a track turned off, or one still being picked, and only count the track’s own runs', () => {
    recommendation('2026-11-20', 'done')
    repo.setSetting(weeklyOffKey(track.id), true)
    expect(weeklyState(repo, track, TODAY)).toEqual({ on: false, last: '2026-11-20', next: null, running: false, problem: null })
    expect(weeklyDue(repo, track, TODAY)).toBe(false)

    const picking = repo.createTrack({ name: '挑选中', brief: '', dimensions: DEFAULT_DIMENSIONS, status: 'picking' })
    expect(weeklyState(repo, picking, TODAY)).toMatchObject({ on: true, next: null })
    recommendation('2026-12-02', 'done', picking.id)
    expect(weeklyState(repo, track, TODAY).last).toBe('2026-11-20')
  })
})
