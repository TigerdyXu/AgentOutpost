import type { Brief, Finding, Id } from './types.ts'

/** The gist of a brief on a day when nothing is worth looking at. */
export const NO_NEWS_GIST = '今天没有值得看的变化'

/** Only checked findings reach the reader: verified ones, and unconfirmed ones (shown with the "待确认" mark). */
const isShown = (f: Finding) => f.status === 'verified' || f.status === 'unconfirmed'

/** Major before notable. Minor findings never compete here: they are folded away from the main list. */
const importanceRank = (f: Finding) => (f.importance === 'major' ? 0 : 1)
const statusRank = (f: Finding) => (f.status === 'verified' ? 0 : 1)

/** Reading order: importance, then verified before unconfirmed, then the earlier-created first. */
function byReadingOrder(a: Finding, b: Finding): number {
  return importanceRank(a) - importanceRank(b) || statusRank(a) - statusRank(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || 0
}

export interface ComposeBriefInput {
  date: string
  /** The findings that belong to this brief; the caller picks the day's. Anything not checked is left out here. */
  findings: Finding[]
  trackedProductIds: Id[]
  skipped: Brief['skipped']
  gist: string
  costYuan: number
  now: Date
  /** The brief already made for this date, if any: the new one replaces it but keeps its creation time. */
  previous: Brief | null
}

/**
 * Builds the day's brief from the findings.
 * - Only `verified` and `unconfirmed` findings appear. `major` and `notable` ones go to `findingIds` (major first, then
 *   verified before unconfirmed, then by creation time); `minor` ones are folded into `minorIds` in the same order.
 * - `quietProductIds` names, in tracking order, the tracked products with nothing in this brief at all, whatever the
 *   importance (a product with only a minor finding is not quiet). A product that was skipped is left out too: it was
 *   not looked at, so "no news" would be untrue; `skipped` already says why.
 * - When there is nothing to show (not even a minor finding) the gist is `NO_NEWS_GIST`, whatever gist was passed.
 */
export function composeBrief(input: ComposeBriefInput): Brief {
  const shown = input.findings.filter(isShown)
  const main = shown.filter((f) => f.importance !== 'minor').sort(byReadingOrder)
  const minor = shown.filter((f) => f.importance === 'minor').sort(byReadingOrder)

  const withNews = new Set(shown.map((f) => f.productId))
  const skipped = new Set(input.skipped.map((s) => s.productId))
  const quiet = [...new Set(input.trackedProductIds)].filter((id) => !withNews.has(id) && !skipped.has(id))

  const stamp = input.now.toISOString()
  return {
    date: input.date,
    gist: shown.length === 0 ? NO_NEWS_GIST : input.gist,
    findingIds: main.map((f) => f.id),
    minorIds: minor.map((f) => f.id),
    quietProductIds: quiet,
    skipped: input.skipped.map((s) => ({ ...s })),
    costYuan: input.costYuan,
    createdAt: input.previous?.createdAt ?? stamp,
    updatedAt: stamp,
  }
}

/**
 * How many of the brief's main findings (`findingIds`) are still unread: the number shown on the sidebar.
 * Folded minor findings are not counted; an id with no finding in `findings` is skipped; an id listed twice counts once.
 */
export function unreadCount(brief: Brief, findings: Map<Id, Finding>): number {
  let n = 0
  for (const id of new Set(brief.findingIds)) if (findings.get(id)?.read === false) n++
  return n
}
