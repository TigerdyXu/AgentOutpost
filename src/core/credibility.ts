import { canonicalUrl } from './url.ts'
import type { ClaimKind, FindingStatus, OpenedVia } from './types.ts'
import { say } from './messages.ts'

/** What one source contributed to one finding, as recorded by the verify step. */
export interface Evidence {
  url: string
  isOfficial: boolean
  syndicationGroup: string | null
  openedVia: OpenedVia
  quoteFound: boolean | null
  supportsClaim: boolean | null
}

export interface Verdict { status: FindingStatus; note: string | null; unconfirmedUntil: string | null }

/** How many days an under-sourced finding stays 「待确认」 before it is 「未证实」 (spec §8). */
export const UNCONFIRMED_WINDOW_DAYS = 7
const WINDOW_MS = UNCONFIRMED_WINDOW_DAYS * 24 * 60 * 60 * 1000

/** What the check found on one source. */
type Seen = Pick<Evidence, 'openedVia' | 'quoteFound' | 'supportsClaim'>

/** Void: really opened (not just a search snippet), and the page does not hold the quote or does not back the claim. */
export const isVoidEvidence = (e: Seen): boolean => (e.openedVia === 'http' || e.openedVia === 'browser') && (e.quoteFound === false || e.supportsClaim === false)

/** Valid: the quote was matched (on the page, or in a search snippet when the page would not open) and nothing says it fails the claim. */
export const isValidEvidence = (e: Seen): boolean => e.quoteFound === true && e.supportsClaim !== false

/**
 * Decides how far a finding can be trusted from the evidence its sources gave (spec §8):
 * - an official source speaking about its own product is enough on its own;
 * - anyone else's claim needs two independent sources, reposts of one press release counting once;
 * - a source that cannot be opened is not a false one: the finding waits as 「待确认」 with 「原文打不开」 (neither plain
 *   fetch nor browser opened it, and for a search snippet that does not match the quote the page is just as unseen);
 * - a source that was opened and does not hold the quote, or does not support the claim, is void, and a finding
 *   whose sources are all void is withdrawn.
 * A finding still short of that after 7 days from `firstSeen` is 「未证实」.
 */
export function judge(input: { claimKind: ClaimKind; evidence: Evidence[]; firstSeen: Date; now: Date }): Verdict {
  const { claimKind, evidence, firstSeen, now } = input

  const valid = evidence.filter(isValidEvidence)

  // With no source at all there is nothing to hold on to: spec §8.1 says a claim without one is not taken in.
  if (evidence.length === 0 || evidence.every(isVoidEvidence)) {
    return { status: 'withdrawn', note: say('quoteUnsupported'), unconfirmedUntil: null }
  }

  const independent = new Set(valid.map((e) => e.syndicationGroup ?? canonicalUrl(e.url))).size
  if (claimKind === 'self' && valid.some((e) => e.isOfficial)) return { status: 'verified', note: null, unconfirmedUntil: null }
  if (independent >= 2) return { status: 'verified', note: null, unconfirmedUntil: null }

  // Unseen: never opened, or only a search snippet that did not match (spec §8.2).
  const unseen = (e: Evidence) => e.openedVia === 'unopened' || (e.openedVia === 'snippet' && e.quoteFound !== true)

  const deadline = new Date(firstSeen.getTime() + WINDOW_MS)
  return {
    status: now.getTime() > deadline.getTime() ? 'unproven' : 'unconfirmed',
    note: evidence.some(unseen) ? say('unopened') : say('oneSource'),
    unconfirmedUntil: deadline.toISOString(),
  }
}
