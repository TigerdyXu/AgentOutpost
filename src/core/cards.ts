import { diffChars } from 'diff'
import type { CardEdit, CardVersion, DimensionKey, Id, Span } from './types.ts'

const FRESH_MS = 72 * 60 * 60 * 1000

export type CardEditInput = Pick<CardEdit, 'summary' | 'bullets' | 'body' | 'sourceIds' | 'inferenceSpans' | 'changeNote' | 'findingIds'> & { productId: Id; dimension: DimensionKey }

/**
 * The ranges of `next` that are not in `prev`, found by a character diff. Offsets count UTF-16 units of `next` (what
 * `next.slice(start, end)` takes, `end` exclusive). Removed text leaves no span.
 */
function insertedSpans(prev: string, next: string): Span[] {
  const spans: Span[] = []
  let pos = 0
  for (const part of diffChars(prev, next)) {
    if (part.removed) continue
    const end = pos + part.value.length
    if (part.added) spans.push({ start: pos, end })
    pos = end
  }
  return spans
}

/**
 * The next version of a dossier card from an edit. `version` is one more than `prev`'s (1 for a first version).
 * `addedSpans` marks what the edit added to `prev`'s body, so the reader can see what changed; a first version has none
 * (setting up the card is not a change worth highlighting).
 */
export function applyCardEdit(prev: CardVersion | null, edit: CardEditInput, now: Date): CardVersion {
  return {
    productId: edit.productId,
    dimension: edit.dimension,
    version: (prev?.version ?? 0) + 1,
    summary: edit.summary,
    bullets: [...edit.bullets],
    body: edit.body,
    sourceIds: [...edit.sourceIds],
    inferenceSpans: edit.inferenceSpans.map((s) => ({ ...s })),
    addedSpans: prev ? insertedSpans(prev.body, edit.body) : [],
    changeNote: edit.changeNote,
    findingIds: [...edit.findingIds],
    createdAt: now.toISOString(),
  }
}

/**
 * Whether the card's newest text is still highlighted as new: it was written no more than 72 hours ago (a full 72 hours
 * still counts). A stamp that cannot be read is not fresh; one slightly in the future (clock skew) is.
 */
export function isFresh(card: CardVersion, now: Date): boolean {
  const made = Date.parse(card.createdAt)
  return !Number.isNaN(made) && now.getTime() - made <= FRESH_MS
}
