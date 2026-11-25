import { describe, expect, it } from 'vitest'
import { localDate } from '../../src/core/calendar.ts'
import { normalizeDate } from '../../src/core/dates.ts'

describe('normalizeDate', () => {
  it('keeps a plain YYYY-MM-DD as it is', () => {
    expect(normalizeDate('2026-11-24')).toBe('2026-11-24')
  })

  it('reads slash, dot and Chinese forms, with or without zero padding', () => {
    expect(normalizeDate('2026/11/24')).toBe('2026-11-24')
    expect(normalizeDate('2026.11.24')).toBe('2026-11-24')
    expect(normalizeDate('2026年11月24日')).toBe('2026-11-24')
    expect(normalizeDate('2026年1月5日')).toBe('2026-01-05')
    expect(normalizeDate('2026/1/5')).toBe('2026-01-05')
    expect(normalizeDate('2026.1.5')).toBe('2026-01-05')
    expect(normalizeDate('2026-1-5')).toBe('2026-01-05')
  })

  it('ignores surrounding spaces and reads full-width digits and marks', () => {
    expect(normalizeDate('  2026-11-24  ')).toBe('2026-11-24')
    expect(normalizeDate('２０２６年１１月２４日')).toBe('2026-11-24')
    expect(normalizeDate('2026．11．24')).toBe('2026-11-24')
  })

  it('takes the date as written from a datetime with no time zone', () => {
    expect(normalizeDate('2026-11-24T10:30:00')).toBe('2026-11-24')
    expect(normalizeDate('2026-11-24 23:59')).toBe('2026-11-24')
    expect(normalizeDate('2026年11月24日 10:30')).toBe('2026-11-24')
  })

  it('turns a datetime that names a time zone into the local day it falls on', () => {
    // Same moment in three spellings: the answer is the local calendar day of that moment, whatever zone the machine is in.
    const local = localDate(new Date('2026-11-24T12:00:00Z'))
    expect(normalizeDate('2026-11-24T12:00:00Z')).toBe(local)
    expect(normalizeDate('2026-11-24T12:00:00.000Z')).toBe(local)
    expect(normalizeDate('2026-11-24T20:00:00+08:00')).toBe(local)
    expect(normalizeDate('2026-11-24T20:00:00+0800')).toBe(local)
    expect(normalizeDate('2026-11-24 20:00:00 +08:00')).toBe(local)
  })

  it('returns null for text that is not a date, and for days that do not exist', () => {
    for (const bad of ['', '   ', 'yesterday', '3天前', '2026', '2026-11', '11/24/2026', 'Nov 24, 2026', '2026-13-01', '2026-02-30', '2026-00-10', '2026-11-00', '2026-11-24abc', '12345678'])
      expect(normalizeDate(bad), JSON.stringify(bad)).toBeNull()
  })

  it('returns null when there is nothing to read', () => {
    expect(normalizeDate(undefined)).toBeNull()
  })

  it('accepts the 29th of February only in a leap year', () => {
    expect(normalizeDate('2028-02-29')).toBe('2028-02-29')
    expect(normalizeDate('2026-02-29')).toBeNull()
  })
})
