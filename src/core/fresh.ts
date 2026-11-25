import type { CardVersion } from './types.ts'

const FRESH_MS = 72 * 60 * 60 * 1000

/**
 * Whether the card's newest text is still highlighted as new: it was written no more than 72 hours ago (a full 72 hours
 * still counts). A stamp that cannot be read is not fresh; one slightly in the future (clock skew) is.
 */
export function isFresh(card: CardVersion, now: Date): boolean {
  const made = Date.parse(card.createdAt)
  return !Number.isNaN(made) && now.getTime() - made <= FRESH_MS
}
