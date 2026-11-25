import type { Heat } from './types.ts'

const WEEKS = 5
const DAYS_PER_WEEK = 7
const MIN_DATED = 5
const DAY_MS = 24 * 60 * 60 * 1000

/** Number of the local calendar day: equal for two moments on the same wall-clock day, and 1 apart for consecutive days. */
const dayNumber = (d: Date) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS)

/**
 * The local calendar day of a publish date. `YYYY-MM-DD` is that day as written; anything else (an ISO time with a zone,
 * say) is the local day the moment falls on. Returns null for text that is not a date, or a day that does not exist.
 */
function dayOf(text: string | null): number | null {
  if (text === null) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim())
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const date = new Date(y, mo - 1, d)
    return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d ? dayNumber(date) : null
  }
  const t = Date.parse(text)
  return Number.isNaN(t) ? null : dayNumber(new Date(t))
}

/**
 * How lively the news about a product has been, from the publish dates of the articles found about it.
 * - `foundCount` is every article found (`dates.length`), dated or not.
 * - `datedWeekly` counts dated articles in the last 5 weeks, oldest week first. The newest week is the 7 days ending
 *   today, the one before it the 7 days before that, and so on; older articles fall in no week. A date that cannot be
 *   read, or lies after today, is not a date here.
 * - With fewer than 5 dated articles there is too little to judge: no bars, trend `unknown`.
 * - Otherwise the trend compares the average of the last 2 weeks with the average of the 3 weeks before: more than 1.25
 *   times is `up`, less than 0.8 times is `down`, anything else `flat`.
 */
export function weeklyHeat(dates: (string | null)[], now: Date): Heat {
  const today = dayNumber(now)
  const weekly = new Array<number>(WEEKS).fill(0)
  let dated = 0
  for (const text of dates) {
    const day = dayOf(text)
    if (day === null || day > today) continue
    dated++
    const weeksAgo = Math.floor((today - day) / DAYS_PER_WEEK)
    if (weeksAgo < WEEKS) weekly[WEEKS - 1 - weeksAgo]!++
  }
  const heat = { foundCount: dates.length, datedWeekly: weekly }
  if (dated < MIN_DATED) return { ...heat, trend: 'unknown', showBars: false }

  const earlier = weekly[0]! + weekly[1]! + weekly[2]! // 3 weeks
  const recent = weekly[3]! + weekly[4]! // 2 weeks
  // recent/2 > earlier/3 * 1.25  and  recent/2 < earlier/3 * 0.8, cleared of fractions so a tie is a tie exactly.
  const trend = 6 * recent > 5 * earlier ? 'up' : 15 * recent < 8 * earlier ? 'down' : 'flat'
  return { ...heat, trend, showBars: true }
}
