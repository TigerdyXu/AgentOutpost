import { describe, expect, it } from 'vitest'
import { localDate } from '../../src/core/calendar.ts'
import { weeklyHeat } from '../../src/core/hotness.ts'

// "now" is built from local components, and every article date is "n days before now" as a local calendar day, so the
// cases mean the same thing in every time zone.
const now = new Date(2026, 10, 25, 15, 48)
const ago = (days: number) => localDate(new Date(2026, 10, 25 - days))

/** `counts` = articles per week, oldest week first: [w0, w1, w2, w3, w4] with w4 the current week (0..6 days ago). */
const weeks = (counts: number[]): string[] => counts.flatMap((n, w) => Array.from({ length: n }, (_, i) => ago((4 - w) * 7 + (i % 7))))

describe('weeklyHeat', () => {
  it('hides heat bars with fewer than 5 dated articles', () => {
    const heat = weeklyHeat([ago(0), ago(3), ago(10), ago(20)], now)
    expect(heat.showBars).toBe(false)
    expect(heat.trend).toBe('unknown')
    expect(heat.foundCount).toBe(4)
  })

  it('shows heat bars from 5 dated articles on', () => {
    const heat = weeklyHeat([ago(0), ago(3), ago(10), ago(20), ago(30)], now)
    expect(heat.showBars).toBe(true)
    expect(heat.trend).not.toBe('unknown')
  })

  it('counts every article found, but only the dated ones decide whether to show bars', () => {
    const heat = weeklyHeat([ago(0), ago(1), null, null, ago(8), null, ago(15), null], now)
    expect(heat.foundCount).toBe(8)
    expect(heat.showBars).toBe(false)
    expect(heat.trend).toBe('unknown')
    // Five dated plus any number of undated shows the bars, and the undated ones fall in no week.
    const five = weeklyHeat([ago(0), ago(1), ago(8), ago(15), ago(22), null, null, null], now)
    expect(five.foundCount).toBe(8)
    expect(five.showBars).toBe(true)
    expect(five.datedWeekly.reduce((a, b) => a + b, 0)).toBe(5)
  })

  it('has nothing to show for no articles at all', () => {
    expect(weeklyHeat([], now)).toEqual({ foundCount: 0, datedWeekly: [0, 0, 0, 0, 0], trend: 'unknown', showBars: false })
  })

  it('buckets the last 5 weeks oldest first, and the newest week is the 7 days ending today', () => {
    const heat = weeklyHeat([ago(0), ago(6), ago(7), ago(13), ago(14), ago(20), ago(21), ago(27), ago(28), ago(34)], now)
    expect(heat.datedWeekly).toEqual([2, 2, 2, 2, 2])
    const edges = weeklyHeat([ago(0), ago(6)], now).datedWeekly
    expect(edges).toEqual([0, 0, 0, 0, 2])
    expect(weeklyHeat([ago(7)], now).datedWeekly).toEqual([0, 0, 0, 1, 0])
    expect(weeklyHeat([ago(28)], now).datedWeekly).toEqual([1, 0, 0, 0, 0])
    expect(weeklyHeat([ago(34)], now).datedWeekly).toEqual([1, 0, 0, 0, 0])
  })

  it('always returns 5 buckets, also when the bars are hidden', () => {
    expect(weeklyHeat([ago(1)], now).datedWeekly).toEqual([0, 0, 0, 0, 1])
    expect(weeklyHeat([ago(1), ago(9)], now).datedWeekly).toHaveLength(5)
  })

  it('leaves articles older than 5 weeks out of the buckets but still counts them as dated', () => {
    const heat = weeklyHeat([ago(35), ago(50), ago(90), ago(200), ago(400), ago(2)], now)
    expect(heat.datedWeekly).toEqual([0, 0, 0, 0, 1])
    expect(heat.foundCount).toBe(6)
    expect(heat.showBars).toBe(true)
    // Long quiet: nothing recent, nothing before it in the window either -> flat, not invented growth or decline.
    expect(weeklyHeat([ago(35), ago(50), ago(90), ago(200), ago(400)], now)).toEqual({ foundCount: 5, datedWeekly: [0, 0, 0, 0, 0], trend: 'flat', showBars: true })
  })

  it('reads date-only strings as the local calendar day and ISO times as the local day they fall on', () => {
    const noon = (days: number) => new Date(2026, 10, 25 - days, 12, 0).toISOString()
    const lateNight = (days: number) => new Date(2026, 10, 25 - days, 23, 59, 59).toISOString()
    const early = (days: number) => new Date(2026, 10, 25 - days, 0, 0, 1).toISOString()
    // Same local day, three different ways of writing it.
    expect(weeklyHeat([ago(7), noon(7), lateNight(7), early(7)], now).datedWeekly).toEqual([0, 0, 0, 4, 0])
    expect(weeklyHeat([noon(6), lateNight(6), early(6)], now).datedWeekly).toEqual([0, 0, 0, 0, 3])
  })

  it('keeps an article from later today in the current week', () => {
    expect(weeklyHeat([new Date(2026, 10, 25, 23, 0).toISOString()], now).datedWeekly).toEqual([0, 0, 0, 0, 1])
  })

  it('does not count dates it cannot read, or dated after today, as dated', () => {
    const tomorrow = ago(-1)
    const heat = weeklyHeat(['not a date', '', '2026-02-31', '2026-13-01', tomorrow, '2099-01-01', ago(1), ago(2), ago(3), ago(4)], now)
    expect(heat.foundCount).toBe(10)
    expect(heat.datedWeekly).toEqual([0, 0, 0, 0, 4])
    // Only four readable dates -> bars stay hidden.
    expect(heat.showBars).toBe(false)
    expect(heat.trend).toBe('unknown')
  })

  describe('trend (last 2 weeks average against the 3 weeks before)', () => {
    const trendOf = (counts: number[]) => weeklyHeat(weeks(counts), now).trend

    it('is up when the last 2 weeks average is over 1.25 times the earlier average', () => {
      expect(trendOf([1, 1, 1, 3, 3])).toBe('up')
      expect(trendOf([0, 0, 0, 2, 3])).toBe('up')
      // The earlier weeks were empty: any new activity is a rise.
      expect(trendOf([0, 0, 0, 0, 5])).toBe('up')
    })

    it('is down when the last 2 weeks average is under 0.8 times the earlier average', () => {
      expect(trendOf([3, 3, 3, 1, 1])).toBe('down')
      expect(trendOf([4, 3, 2, 0, 0])).toBe('down')
      expect(trendOf([2, 2, 2, 0, 0])).toBe('down')
    })

    it('is flat in between', () => {
      expect(trendOf([2, 2, 2, 2, 2])).toBe('flat')
      expect(trendOf([2, 3, 2, 3, 2])).toBe('flat')
    })

    it('is flat exactly on the 1.25 limit and exactly on the 0.8 limit', () => {
      // earlier average 2 (6/3), recent average 2.5 (5/2): exactly 1.25 times -> not up
      expect(trendOf([2, 2, 2, 2, 3])).toBe('flat')
      // one more article in the last two weeks tips it over
      expect(trendOf([2, 2, 2, 3, 3])).toBe('up')
      // earlier average 5 (15/3), recent average 4 (8/2): exactly 0.8 times -> not down
      expect(trendOf([5, 5, 5, 4, 4])).toBe('flat')
      // one fewer tips it under
      expect(trendOf([5, 5, 5, 4, 3])).toBe('down')
    })

    it('weighs the two recent weeks together, not week by week', () => {
      // Last week empty but the week before busy: the average of the two still decides.
      expect(trendOf([2, 2, 2, 6, 0])).toBe('up')
      expect(trendOf([2, 2, 2, 0, 6])).toBe('up')
    })

    it('uses the earlier weeks as a group too', () => {
      expect(trendOf([6, 0, 0, 2, 2])).toBe('flat')
      expect(trendOf([0, 0, 6, 2, 2])).toBe('flat')
    })

    it('is unknown (not flat) when there are too few dated articles, however the weeks look', () => {
      expect(trendOf([0, 0, 0, 2, 2])).toBe('unknown')
      expect(trendOf([1, 0, 0, 0, 3])).toBe('unknown')
    })

    it('reports the bucket counts alongside the trend', () => {
      const heat = weeklyHeat(weeks([1, 1, 1, 3, 3]), now)
      expect(heat).toEqual({ foundCount: 9, datedWeekly: [1, 1, 1, 3, 3], trend: 'up', showBars: true })
    })
  })
})
