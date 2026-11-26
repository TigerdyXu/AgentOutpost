import { canonicalUrl } from './url.ts'
import type { Id, SourceKind } from './types.ts'

// The one canonicalUrl lives in url.ts and keeps the query (a WeChat article is told apart only by its query).
export { canonicalUrl }

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Canonical form of each address, empty ones dropped, repeats removed, sorted. */
function canonicalUrls(urls: string[]): string[] {
  return [...new Set(urls.filter((u) => u.trim() !== '').map(canonicalUrl))].sort(byCodeUnits)
}

/**
 * The headline as a comparison text: full-width forms folded to normal ones, case, whitespace and punctuation gone,
 * except a mark standing directly between two digits, which is kept because it is part of the number: `1.5` is not
 * `15`, `3-5` is not `35`, `10:30` is not `1030`, `GPT-4.5` is not `GPT-45`. A comma counts like any other such mark, so
 * `1,000` and `1000` read as different headlines: a missed merge shows a story twice, a wrong one hides a finding.
 * (Marks around the digits with a space in between, as in `3 - 5`, are still dropped.)
 */
function headlineText(headline: string): string {
  return headline
    .normalize('NFKC')
    .toLowerCase()
    .replace(/((?<=\p{Nd})\p{P}(?=\p{Nd}))|[\p{P}\s]/gu, (_, between: string | undefined) => between ?? '')
}

/**
 * A stable key for "the same finding": the product, the headline without whitespace/punctuation/case, and the sorted
 * canonical URLs, so the key itself tells the same headline over different articles apart. (`isDuplicate` also compares
 * headlines on their own; see there.)
 */
export function findingKey(productId: Id, headline: string, urls: string[]): string {
  return JSON.stringify([productId, headlineText(headline), canonicalUrls(urls)])
}

/**
 * A source of a finding as `isDuplicate` sees it: its raw address, with its kind and whether it is the product's own when
 * those are known (a bare address counts as an ordinary article).
 */
export type DedupeSource = string | { url: string; kind: SourceKind; isOfficial: boolean }

/** The address of a `DedupeSource`. */
export const sourceUrl = (s: DedupeSource): string => typeof s === 'string' ? s : s.url

/**
 * A page whose content changes under one address: an official page (a changelog, release notes, the official blog) or an
 * app store page. Two findings citing it can be two different pieces of news, so sharing it says nothing.
 */
const isStandingPage = (s: DedupeSource) => typeof s !== 'string' && (s.isOfficial || s.kind === 'official' || s.kind === 'appstore')

/** The canonical addresses of the `sources` that are articles (not standing pages), empty ones dropped. */
function articleUrls(sources: DedupeSource[], standing: Set<string>): Set<string> {
  return new Set(sources.map(sourceUrl).filter((u) => u.trim() !== '').map(canonicalUrl).filter((u) => !standing.has(u)))
}

/** What `isDuplicate` needs to know about an earlier finding. `headline` is the finding's own headline, as written. */
export interface RecentFinding { productId: Id; headline: string; dedupeKey: string; urls: DedupeSource[] }

/**
 * Whether a candidate finding repeats a recent one of the same product. It does if any of these holds:
 * - the key is the same (same headline text over the same articles);
 * - they share an article (canonical URL), whatever the headlines say. A standing page (official, or an app store page,
 *   as either side describes it) does not count: a changelog or an App Store page shows new entries under one address;
 * - the headline text is the same (whitespace, punctuation and case ignored), whatever articles each cites: the same
 *   news found again through another repost, or submitted again the next day.
 * `urls` on both sides are the raw source addresses, not canonical forms. Findings of other products never match, and
 * a headline that is nothing but punctuation and spaces is not compared by its text.
 */
export function isDuplicate(c: { productId: Id; headline: string; urls: DedupeSource[] }, recent: RecentFinding[]): boolean {
  const key = findingKey(c.productId, c.headline, c.urls.map(sourceUrl))
  const text = headlineText(c.headline)
  return recent.some((r) => {
    if (r.productId !== c.productId) return false
    if (r.dedupeKey === key || (text !== '' && headlineText(r.headline) === text)) return true
    const standing = new Set([...c.urls, ...r.urls].filter(isStandingPage).map((s) => canonicalUrl(sourceUrl(s))))
    const mine = articleUrls(c.urls, standing)
    return [...articleUrls(r.urls, standing)].some((u) => mine.has(u))
  })
}
