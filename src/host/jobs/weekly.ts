/**
 * 每周推荐新产品 (M2.2, design §7.1 每周刷新): once a week, a track that is on gets a new batch of candidates, found by the
 * track's usual recommendation session asked for what is new since the last batch. The batch shows where every batch does,
 * under 「候选推荐 n 条待看」 in the middle column.
 *
 * A week counts from the track's last recommendation that ran to its end (the first one, a 「再推荐一批」 or a weekly
 * one): one skipped for the budget, failed or interrupted does not count, and is tried again the next day, once a day.
 * The user turns it off, track by track, on the track's page; it is on unless they did.
 */
import { shiftDate } from '../../core/calendar.ts'
import type { Id, Run, Track } from '../../core/types.ts'
import type { Repo } from '../../store/repo.ts'

/** A track gets new suggestions this many days after its last recommendation finished. */
export const WEEKLY_EVERY_DAYS = 7
/** Settings key, per track: `true` when its weekly suggestions are turned off. */
export const weeklyOffKey = (trackId: Id) => `weeklySuggestionsOff:${trackId}`
/** What the weekly recommendation is asked, as the user's adjustment of the batch (prompts/recommend.md 「调整要求」). */
export const WEEKLY_REFINE = '每周例行刷新：只交上一轮之后新出现的、或者有了新进展值得再看一眼的产品；上一轮交过、没有新变化的不要重复交；够格的少就少交，一个都没有也行。'

/** How a track's weekly suggestions stand on `today`. */
export interface WeeklyState {
  /** Not turned off by the user. */
  on: boolean
  /** The day of its last recommendation that ran to its end, or null. */
  last: string | null
  /** The day the next one is due (today when it is due now), or null when it is off or the track is not started. */
  next: string | null
  /** A recommendation of the track is queued or running now. */
  running: boolean
}

const active = (r: Run) => r.status === 'queued' || r.status === 'running'

export function weeklyState(repo: Repo, track: Track, today: string): WeeklyState {
  const runs = repo.listRuns('').filter(r => r.kind === 'recommend' && r.trackId === track.id) // newest first
  const on = repo.getSetting<boolean>(weeklyOffKey(track.id)) !== true
  const last = runs.find(r => r.status === 'done')?.date ?? null
  const running = runs.some(active)
  if (!on || track.status !== 'active') return { on, last, next: null, running }
  const due = last === null ? today : shiftDate(last, WEEKLY_EVERY_DAYS)
  // Due already: today, unless it was tried today (then tomorrow; one try a day).
  const next = due > today ? due : runs.some(r => r.date === today) ? shiftDate(today, 1) : today
  return { on, last, next, running }
}

/** Whether the track should get its weekly suggestions now, on `today`. */
export function weeklyDue(repo: Repo, track: Track, today: string): boolean {
  const state = weeklyState(repo, track, today)
  return state.next !== null && state.next <= today && !state.running
}
