/**
 * The text of a dossier card (design §5.4) as React nodes, never as HTML: `[n]` becomes a citation of the n-th source,
 * text the last update added is marked (light blue) while it is new, and text that is the AI's own reasoning is followed
 * by 「推论」. Offsets of spans count UTF-16 units of the text, as the host wrote them.
 */
import { Fragment, type ReactNode } from 'react'
import type { Source, Span } from '../../../core/types.ts'
import { Citation } from '../../ui/Citation.tsx'
import { Tag } from '../../ui/Tag.tsx'

/** A stretch of the text that is one citation, or plain text, with what marks it. */
interface Piece { text: string; cite: number | null; added: boolean; inferred: boolean }

/** The spans that cover something inside `length` characters, cut to it. */
function usable(spans: readonly Span[], length: number): Span[] {
  return spans.flatMap(({ start, end }) => {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return []
    const from = Math.max(0, Math.min(length, Math.floor(start)))
    const to = Math.max(0, Math.min(length, Math.floor(end)))
    return to > from ? [{ start: from, end: to }] : []
  })
}

/** Two added stretches this close (in characters), or with only punctuation, spaces and citations between them, read as one. */
const ADDED_GAP = 3

/**
 * The added spans of `text` with the small gaps between them closed: a reworded sentence's new words, compared character
 * by character, come in many short pieces, which read as one change (M1 defect 7). A stretch with no word in it (a 「；」
 * for a 「。」, a citation moved) is left out: alone, it marked a box around a punctuation mark (M3.1).
 */
export function joinAdded(text: string, spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const joined: Span[] = []
  for (const span of sorted) {
    const last = joined.at(-1)
    const gap = last ? text.slice(last.end, span.start) : ''
    if (last && span.start <= last.end + ADDED_GAP || last && /^(?:[\s\p{P}\p{S}]|\[\d+\])*$/u.test(gap)) last!.end = Math.max(last!.end, span.end)
    else joined.push({ ...span })
  }
  return joined.filter(span => /[\p{L}\p{N}]/u.test(text.slice(span.start, span.end).replace(/\[\d+\]/g, '')))
}

/**
 * Cuts `text` wherever a citation, an inference span or an added span begins or ends. A citation `[12]` is never cut
 * through: a span edge inside it moves out, so the marker is in a span when its first character is.
 */
export function splitText(text: string, inference: readonly Span[], added: readonly Span[]): Piece[] {
  const marks = [...text.matchAll(/\[(\d+)\]/g)].map(match => ({ start: match.index, end: match.index + match[0].length, n: Number(match[1]) }))
  const inferred = usable(inference, text.length)
  const addedSpans = joinAdded(text, usable(added, text.length))
  const cuts = new Set([0, text.length, ...marks.flatMap(mark => [mark.start, mark.end]), ...[...inferred, ...addedSpans].flatMap(span => [span.start, span.end])])
  const edges = [...cuts].filter(cut => !marks.some(mark => mark.start < cut && cut < mark.end)).sort((a, b) => a - b)
  const covers = (spans: Span[], at: number) => spans.some(span => span.start <= at && at < span.end)
  return edges.slice(0, -1).map((start, i) => {
    const end = edges[i + 1]!
    return {
      text: text.slice(start, end), cite: marks.find(mark => mark.start === start)?.n ?? null,
      added: covers(addedSpans, start), inferred: covers(inferred, start),
    }
  })
}

type SourceOf = (n: number) => Source | undefined

/** Plain pieces as nodes, the neighbouring bits of text joined into one text node. */
function nodes(pieces: Piece[], sourceOf: SourceOf): ReactNode[] {
  const out: ReactNode[] = []
  let run = ''
  // A blank line between paragraphs is a short gap (its characters stay in the text, hidden by the stylesheet).
  const flush = () => {
    run.split(/(\n{2,})/).forEach((part, i) => { if (part) out.push(i % 2 === 1 ? <span className="op-para">{part}</span> : part) })
    run = ''
  }
  for (const piece of pieces) {
    if (piece.cite === null) { run += piece.text; continue }
    flush()
    out.push(<Citation key={out.length} n={piece.cite} source={sourceOf(piece.cite)} />)
  }
  flush()
  return out.map((node, i) => <Fragment key={i}>{node}</Fragment>)
}

/** Consecutive pieces that are added, in one highlighted run; the rest as it is. */
function withHighlights(pieces: Piece[], sourceOf: SourceOf): ReactNode[] {
  const out: ReactNode[] = []
  for (let i = 0; i < pieces.length;) {
    let j = i
    while (j < pieces.length && pieces[j]!.added === pieces[i]!.added) j++
    const group = nodes(pieces.slice(i, j), sourceOf)
    out.push(pieces[i]!.added ? <mark key={i} className="op-added">{group}</mark> : <Fragment key={i}>{group}</Fragment>)
    i = j
  }
  return out
}

/**
 * `text` with its citations, `added` highlighted and `inference` tagged. Pass no `added` once the card is no longer new.
 * Spans that touch or overlap make one stretch: one 「推论」 follows its end, whatever the added spans do inside it.
 */
export function RichText({ text, sourceOf, inference = [], added = [] }: { text: string; sourceOf: SourceOf; inference?: readonly Span[]; added?: readonly Span[] }): ReactNode {
  const pieces = splitText(text, inference, added)
  const out: ReactNode[] = []
  for (let i = 0; i < pieces.length;) {
    let j = i
    while (j < pieces.length && pieces[j]!.inferred === pieces[i]!.inferred) j++
    const group = withHighlights(pieces.slice(i, j), sourceOf)
    if (pieces[i]!.inferred) out.push(<Fragment key={i}><span className="op-infer">{group}</span><Tag kind="inference" /></Fragment>)
    else out.push(<Fragment key={i}>{group}</Fragment>)
    i = j
  }
  return <>{out}</>
}
