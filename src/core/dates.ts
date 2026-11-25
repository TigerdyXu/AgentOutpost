import { localDate } from './calendar.ts'

/** `YYYY-MM-DD`, `YYYY/M/D`, `YYYY.M.D` or `YYYY年M月D日`, optionally followed by a time of day (after `T` or a space). */
const WRITTEN = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(?:[T\s].*)?$/
/** An ISO-like date and time that ends in a time zone: `Z`, `+08:00`, `+0800` or `+08`. */
const ZONED = /^(\d{4}-\d{2}-\d{2})[T\s]+(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i

const pad = (n: number) => String(n).padStart(2, '0')

/** Whether year, month and day name a day that exists (February 30th does not). */
function isRealDay(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** `+0800` and `+08` to `+08:00`, the only offset spelling `Date.parse` is bound to read. */
function isoOffset(zone: string): string {
  if (/^z$/i.test(zone)) return 'Z'
  const digits = zone.slice(1).replace(':', '')
  return `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2) || '00'}`
}

/**
 * A publish date as `YYYY-MM-DD`, whatever way the agent wrote it, or null when it cannot be read (never an error: a
 * source without a usable date is still a source). Reads the forms the WRITTEN pattern describes; a time of day
 * without a zone is dropped, the day stays as written. A time that names a zone is a moment, so it becomes the local
 * calendar day that moment falls on, the same way `weeklyHeat` reads such a stamp. Full-width digits count as digits.
 */
export function normalizeDate(text: string | undefined): string | null {
  if (text === undefined) return null
  const t = text.normalize('NFKC').trim()

  const zoned = ZONED.exec(t)
  if (zoned) {
    const [y, m, d] = zoned[1]!.split('-').map(Number) as [number, number, number]
    if (!isRealDay(y, m, d)) return null
    const moment = Date.parse(`${zoned[1]}T${zoned[2]}${isoOffset(zoned[3]!)}`)
    return Number.isNaN(moment) ? null : localDate(new Date(moment))
  }

  const written = WRITTEN.exec(t)
  if (!written) return null
  const [y, m, d] = [Number(written[1]), Number(written[2]), Number(written[3])]
  return isRealDay(y, m, d) ? `${written[1]}-${pad(m)}-${pad(d)}` : null
}
