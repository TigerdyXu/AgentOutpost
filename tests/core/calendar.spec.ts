import { describe, expect, it } from 'vitest'
import { cutoffAt, localDate, nextRunAt, shouldCatchUp, tomorrowRunAt } from '../../src/core/calendar.ts'

// Every date here is built from explicit local components (month is 1-based), never from an ISO string or a fixed UTC
// instant. The functions under test speak in the machine's local time zone, so the cases mean the same wall-clock time
// whatever zone the machine is in. (None of the dates is near a DST switch.)
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms)

describe('localDate', () => {
  it('formats the local calendar day as YYYY-MM-DD with zero padding', () => {
    expect(localDate(at(2026, 11, 25, 15, 48))).toBe('2026-11-25')
    expect(localDate(at(2026, 1, 5, 9))).toBe('2026-01-05')
  })

  it('switches day at local midnight, not at UTC midnight', () => {
    expect(localDate(at(2026, 11, 25, 23, 59, 59, 999))).toBe('2026-11-25')
    expect(localDate(at(2026, 11, 26, 0, 0, 0, 0))).toBe('2026-11-26')
    expect(localDate(at(2026, 12, 31, 23, 30))).toBe('2026-12-31')
    expect(localDate(at(2027, 1, 1, 0, 30))).toBe('2027-01-01')
  })
})

describe('nextRunAt', () => {
  it('at 07:59 the run is today at 08:00', () => {
    expect(nextRunAt(at(2026, 11, 25, 7, 59), '08:00')).toEqual(at(2026, 11, 25, 8, 0))
  })

  it('at exactly 08:00 the time has passed, so the next run is tomorrow at 08:00', () => {
    // Strictly after "now": the scheduler re-arms with nextRunAt(now) right after a run fires at 08:00:00.000,
    // and must not get the same instant back.
    expect(nextRunAt(at(2026, 11, 25, 8, 0), '08:00')).toEqual(at(2026, 11, 26, 8, 0))
    expect(nextRunAt(at(2026, 11, 25, 8, 0, 0, 1), '08:00')).toEqual(at(2026, 11, 26, 8, 0))
  })

  it('at 23:00 the run is tomorrow at 08:00', () => {
    expect(nextRunAt(at(2026, 11, 25, 23, 0), '08:00')).toEqual(at(2026, 11, 26, 8, 0))
  })

  it('rolls over month and year ends', () => {
    expect(nextRunAt(at(2026, 11, 30, 23, 0), '08:00')).toEqual(at(2026, 12, 1, 8, 0))
    expect(nextRunAt(at(2026, 12, 31, 23, 0), '08:00')).toEqual(at(2027, 1, 1, 8, 0))
  })

  it('uses the configured time, and zeroes seconds and milliseconds', () => {
    expect(nextRunAt(at(2026, 11, 25, 0, 10), '00:30')).toEqual(at(2026, 11, 25, 0, 30))
    expect(nextRunAt(at(2026, 11, 25, 18, 45), '18:30')).toEqual(at(2026, 11, 26, 18, 30))
    const next = nextRunAt(at(2026, 11, 25, 7, 59, 30, 500), '08:00')
    expect([next.getSeconds(), next.getMilliseconds()]).toEqual([0, 0])
  })

  it('does not modify the date it was given', () => {
    const now = at(2026, 11, 25, 23, 0)
    nextRunAt(now, '08:00')
    expect(now).toEqual(at(2026, 11, 25, 23, 0))
  })

  it('rejects a runTime that is not HH:MM', () => {
    for (const bad of ['', '8', '8:00', '08:0', '24:00', '08:60', '08-00', 'abc']) {
      expect(() => nextRunAt(at(2026, 11, 25, 7, 0), bad), bad).toThrow(/HH:MM/)
    }
  })
})

describe('tomorrowRunAt', () => {
  it('is the run time on the local day after now, whatever the time of day and whether today\'s moment has passed', () => {
    expect(tomorrowRunAt(at(2026, 11, 25, 7, 0), '08:00')).toEqual(at(2026, 11, 26, 8, 0))
    expect(tomorrowRunAt(at(2026, 11, 25, 9, 30), '08:00')).toEqual(at(2026, 11, 26, 8, 0))
    expect(tomorrowRunAt(at(2026, 11, 25, 23, 59, 59, 999), '00:00')).toEqual(at(2026, 11, 26, 0, 0))
    expect(tomorrowRunAt(at(2026, 11, 30, 12, 0), '07:00')).toEqual(at(2026, 12, 1, 7, 0))
    expect(() => tomorrowRunAt(at(2026, 11, 25), '24:00')).toThrow('runTime must be HH:MM')
  })
})

describe('shouldCatchUp', () => {
  it('at 14:00 with yesterday as the last completed day: catch up', () => {
    expect(shouldCatchUp(at(2026, 11, 25, 14, 0), '08:00', '2026-11-24')).toBe(true)
  })

  it('at 14:00 with today already completed: do not run twice', () => {
    expect(shouldCatchUp(at(2026, 11, 25, 14, 0), '08:00', '2026-11-25')).toBe(false)
  })

  it('at 07:00 the run time has not come yet: nothing to catch up', () => {
    expect(shouldCatchUp(at(2026, 11, 25, 7, 0), '08:00', '2026-11-24')).toBe(false)
    expect(shouldCatchUp(at(2026, 11, 25, 7, 0), '08:00', null)).toBe(false)
  })

  it('a day that was never completed counts as missed once the time has passed', () => {
    expect(shouldCatchUp(at(2026, 11, 25, 14, 0), '08:00', null)).toBe(true)
    expect(shouldCatchUp(at(2026, 11, 25, 14, 0), '08:00', '2026-11-18')).toBe(true)
  })

  it('treats exactly the run time as passed, so no instant is left uncovered', () => {
    // nextRunAt is strictly after "now", so at 08:00:00.000 only catch-up can still start today's run.
    expect(shouldCatchUp(at(2026, 11, 25, 8, 0), '08:00', '2026-11-24')).toBe(true)
    expect(shouldCatchUp(at(2026, 11, 25, 7, 59, 59, 999), '08:00', '2026-11-24')).toBe(false)
  })

  it('late in the evening the day is still missed; after midnight it is a new day', () => {
    expect(shouldCatchUp(at(2026, 11, 25, 23, 59), '08:00', '2026-11-24')).toBe(true)
    expect(shouldCatchUp(at(2026, 11, 26, 0, 30), '08:00', '2026-11-25')).toBe(false)
  })

  it('follows the configured time', () => {
    expect(shouldCatchUp(at(2026, 11, 25, 14, 0), '18:30', '2026-11-24')).toBe(false)
    expect(shouldCatchUp(at(2026, 11, 25, 19, 0), '18:30', '2026-11-24')).toBe(true)
  })
})

describe('cutoffAt', () => {
  it('is two hours after the start', () => {
    expect(cutoffAt(at(2026, 11, 25, 8, 0))).toEqual(at(2026, 11, 25, 10, 0))
    expect(cutoffAt(at(2026, 11, 25, 14, 7, 9, 123))).toEqual(at(2026, 11, 25, 16, 7, 9, 123))
  })

  it('is exactly 7,200,000 ms later, also across midnight', () => {
    const start = at(2026, 11, 25, 23, 0)
    expect(cutoffAt(start).getTime() - start.getTime()).toBe(2 * 60 * 60 * 1000)
    expect(cutoffAt(start)).toEqual(at(2026, 11, 26, 1, 0))
  })

  it('does not modify the date it was given', () => {
    const start = at(2026, 11, 25, 8, 0)
    cutoffAt(start)
    expect(start).toEqual(at(2026, 11, 25, 8, 0))
  })
})
