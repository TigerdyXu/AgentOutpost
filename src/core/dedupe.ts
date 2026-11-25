import { canonicalUrl } from './url.ts'
import type { Id } from './types.ts'

// The one canonicalUrl lives in url.ts and keeps the query (a WeChat article is told apart only by its query).
export { canonicalUrl }

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Canonical form of each address, empty ones dropped, repeats removed, sorted. */
function canonicalUrls(urls: string[]): string[] {
  return [...new Set(urls.filter((u) => u.trim() !== '').map(canonicalUrl))].sort(byCodeUnits)
}

/** The headline as a comparison text: full-width forms folded to normal ones, case, whitespace and punctuation gone. */
function headlineText(headline: string): string {
  return headline.normalize('NFKC').toLowerCase().replace(/[\p{P}\s]/gu, '')
}

/**
 * A stable key for "the same finding": the product, the headline without whitespace/punctuation/case, and the sorted
 * canonical URLs. The same headline over a different set of articles is a different key, on purpose: a generic headline
 * such as "发布新版本" must not swallow a later, different release.
 */
export function findingKey(productId: Id, headline: string, urls: string[]): string {
  return JSON.stringify([productId, headlineText(headline), canonicalUrls(urls)])
}

/**
 * Whether a candidate finding repeats a recent one of the same product: same key, or any article (canonical URL) in
 * common. `urls` on both sides are the raw source addresses, not canonical forms. Findings of other products never match.
 */
export function isDuplicate(c: { productId: Id; headline: string; urls: string[] }, recent: { productId: Id; dedupeKey: string; urls: string[] }[]): boolean {
  const key = findingKey(c.productId, c.headline, c.urls)
  const mine = new Set(canonicalUrls(c.urls))
  return recent.some((r) => r.productId === c.productId && (r.dedupeKey === key || canonicalUrls(r.urls).some((u) => mine.has(u))))
}
