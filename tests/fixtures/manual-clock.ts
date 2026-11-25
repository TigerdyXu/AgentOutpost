/**
 * A clock that stands still until the test moves it. Moving it forward runs every timer that falls due on the way, in
 * order of their times, with the clock showing each timer's moment while it runs — or, for the one timer after
 * `early(ms)`, that many milliseconds before it, the way Node's timers sometimes fire. `tick` callbacks run once a
 * minute of that clock; they are not among `pending()` and `early` does not apply to them.
 */
import type { Clock } from '../../src/host/ports.ts'

/** A local wall-clock time: a `Date`, or `YYYY-MM-DDTHH:MM[:SS[.mmm]]` read in the machine's time zone. */
export type When = Date | string

export function local(when: When): Date {
  if (when instanceof Date) return when
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?$/.exec(when)
  if (!m) throw new Error(`not a local time: ${when}`)
  const [, y, mo, d, h, mi, s, ms] = m.map(Number)
  return new Date(y!, mo! - 1, d!, h!, mi!, s || 0, ms || 0)
}

export function manualClock(start: When) {
  let time = local(start)
  let earlyMs = 0
  const timers: { when: Date; fn: () => void; live: boolean; tick?: boolean }[] = []
  const clock: Clock = {
    now: () => time,
    at(when, fn) {
      const timer = { when, fn, live: true }
      timers.push(timer)
      return () => { timer.live = false }
    },
    tick(fn) {
      let live = true
      let timer: (typeof timers)[number]
      const arm = () => {
        timer = { when: new Date(time.getTime() + 60_000), live: true, tick: true, fn: () => { if (live) { arm(); fn() } } }
        timers.push(timer)
      }
      arm()
      return () => { live = false; timer.live = false }
    },
  }
  const live = () => timers.filter(t => t.live).sort((a, b) => a.when.getTime() - b.when.getTime())
  return {
    clock,
    /** Moves the clock to `to`, running the timers due by then (also those they set, if due by then too). */
    set(to: When) {
      const target = local(to)
      for (let due = live()[0]; due && due.when.getTime() <= target.getTime(); due = live()[0]) {
        due.live = false
        time = new Date(due.when.getTime() - (due.tick ? 0 : earlyMs))
        if (!due.tick) earlyMs = 0
        due.fn()
      }
      time = target
    },
    /** When the timers still waiting are due, soonest first. */
    pending: (): Date[] => live().filter(t => !t.tick).map(t => t.when),
    /** The next timer to go off fires this many milliseconds before its time. */
    early(ms: number) { earlyMs = ms },
  }
}
