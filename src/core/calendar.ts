/** Run-time calendar helpers. All of them work in the machine's local time zone, which is the user's own wall clock. */

const HOUR_MS = 60 * 60 * 1000

/** `YYYY-MM-DD` of the local calendar day that `d` falls on. */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `runTime` (`HH:MM`) on the local day of `day`, seconds and milliseconds zero. Throws on a malformed `runTime`. */
function atRunTime(day: Date, runTime: string, dayOffset = 0): Date {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(runTime)
  if (!m) throw new Error(`runTime must be HH:MM (00:00 to 23:59), got "${runTime}"`)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + dayOffset, Number(m[1]), Number(m[2]), 0, 0)
}

/**
 * The next moment the daily run is due: today at `runTime`, or tomorrow's if that moment is not strictly in the future.
 * At exactly `runTime` the answer is tomorrow, so a scheduler that re-arms right after a run fired never gets the
 * same instant back; `shouldCatchUp` covers that instant instead.
 */
export function nextRunAt(now: Date, runTime: string): Date {
  const today = atRunTime(now, runTime)
  return today.getTime() > now.getTime() ? today : atRunTime(now, runTime, 1)
}

/** `runTime` on the local day after `now`: where the daily timer goes when today's run is already done, whatever time it is changed to. */
export function tomorrowRunAt(now: Date, runTime: string): Date {
  return atRunTime(now, runTime, 1)
}

/**
 * Whether today's run was missed and should start now: today's `runTime` has arrived (inclusive) and no daily run has
 * completed for today. `lastCompletedDailyDate` is a `localDate` string, or null if none ever completed.
 */
export function shouldCatchUp(now: Date, runTime: string, lastCompletedDailyDate: string | null): boolean {
  return now.getTime() >= atRunTime(now, runTime).getTime() && lastCompletedDailyDate !== localDate(now)
}

/** The deadline for finishing a run that began at `start`: two hours later. */
export function cutoffAt(start: Date): Date {
  return new Date(start.getTime() + 2 * HOUR_MS)
}
