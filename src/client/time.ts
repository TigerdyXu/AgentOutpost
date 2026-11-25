/** Times as the reader's clock has them. */

export const pad = (n: number) => String(n).padStart(2, '0')

/** The time of day of an ISO instant on the reader's clock (`08:12`), or null for one that is no date. */
export function clockTime(iso: string): string | null {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/** The local day (`YYYY-MM-DD`) of an instant on the reader's clock, or null for one that is no date. */
export function localDay(value: Date | string): string | null {
  const at = typeof value === 'string' ? new Date(value) : value
  return Number.isNaN(at.getTime()) ? null : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** `MM-DD` for an instant of this year on the reader's clock, else `YYYY-MM-DD`; null for one that is no date. */
export function shortDay(iso: string, now = new Date()): string | null {
  const day = localDay(iso)
  return day === null ? null : day.startsWith(`${now.getFullYear()}-`) ? day.slice(5) : day
}
