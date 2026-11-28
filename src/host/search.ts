/**
 * The panel's search (M3.2): every word of the query, anywhere in what the panel shows of a followed product, a track, a
 * dossier card, a finding or a topic. Case, full and half width aside (NFKC, lower case); several words must all be
 * there, in any of the thing's fields. Each hit carries a snippet of the field it was found in, with the words marked.
 * Only what Outpost holds is searched; nothing is fetched or paid for.
 */
import { localDate } from '../core/calendar.ts'
import { FOLLOWED } from '../core/identity.ts'
import type { Dimension, DimensionKey, FindingStatus, Id, Product, Span, Track } from '../core/types.ts'
import type { Repo } from '../store/repo.ts'

/** A piece of text around the first word found, and where every word of the query is in it. */
export interface Snippet { text: string; marks: Span[] }

export interface SearchResults {
  query: string
  /** `inNote`: found in the user's own note (M3.3), which the snippet is from. */
  products: { id: Id; name: string; company: string; tracks: string[]; inNote: boolean; snippet: Snippet }[]
  tracks: { id: Id; name: string; snippet: Snippet }[]
  cards: { productId: Id; product: string; dimension: DimensionKey; label: string; snippet: Snippet }[]
  /** `inHeadline`: the snippet is the headline's (else it is from why it matters, and the panel shows the headline too). */
  findings: { id: Id; productId: Id; product: string; date: string; headline: string; status: FindingStatus; inHeadline: boolean; inNote: boolean; snippet: Snippet }[]
  topics: { id: Id; question: string; track: string; snippet: Snippet }[]
  /** How many more of each kind matched than are listed (`SEARCH_LIMIT`). */
  more: { products: number; tracks: number; cards: number; findings: number; topics: number }
}

/** At most this many hits of each kind are listed. */
export const SEARCH_LIMIT = 20
/** The longest query taken. */
export const QUERY_MAX = 60
/** Characters shown before and after the first word found. */
const BEFORE = 24
const AFTER = 64
/** Findings the panel shows (the product's 动态 tab): checked ones, not those unchecked or withdrawn. */
const SHOWN: readonly FindingStatus[] = ['verified', 'unconfirmed', 'unproven']

/**
 * `text` folded for matching, with the index in `text` of each folded character (and `text.length` after the last). When
 * folding keeps every character one for one (most text: no character that NFKC expands or composes), the indices are
 * the identity and the text is folded whole, for speed.
 */
function fold(text: string): { folded: string; at: number[] } {
  const whole = text.normalize('NFKC').toLowerCase()
  // Only composition (combining marks, Hangul jamo) shortens text; without it, an unchanged length means nothing expanded.
  if (whole.length === text.length && !/[\p{M}\u1100-\u11ff\u3130-\u318f]/u.test(text)) {
    return { folded: whole, at: Array.from({ length: text.length + 1 }, (_, i) => i) }
  }
  let folded = ''
  const at: number[] = []
  let i = 0
  for (const ch of text) {
    const f = ch.normalize('NFKC').toLowerCase()
    folded += f
    for (let k = 0; k < f.length; k++) at.push(i)
    i += ch.length
  }
  at.push(text.length)
  return { folded, at }
}

/** The query's words, folded; none for a blank query. */
export function termsOf(query: string): string[] {
  return [...new Set(query.normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean))]
}

/** Where each word occurs in `text`, in `text`'s own indices, sorted and merged. */
function occurrences(text: string, terms: string[]): Span[] {
  const { folded, at } = fold(text)
  const spans: Span[] = []
  for (const term of terms) {
    for (let from = folded.indexOf(term); from >= 0; from = folded.indexOf(term, from + term.length)) {
      // A word ending inside what one character folds to (「㎏」 to 「kg」) ends after that whole character.
      let end = from + term.length
      while (end < at.length - 1 && at[end] === at[end - 1]) end++
      spans.push({ start: at[from]!, end: at[end] ?? text.length })
    }
  }
  spans.sort((a, b) => a.start - b.start)
  const merged: Span[] = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

/** A field as it is searched: citation marks [n] dropped (with the space before a Chinese stop they leave), line breaks as spaces. */
const plain = (text: string) => text.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').replace(/ (?=[，。；：！？、）」』])/g, '').trim()

/** Whether the UTF-16 unit at `i` of `text` is the second half of a character (an emoji, say). */
const lowHalf = (text: string, i: number) => { const code = text.charCodeAt(i); return code >= 0xdc00 && code <= 0xdfff }

/**
 * The snippet of the thing's fields that `terms` all appear in, or null when one is missing: from the field holding the
 * most words (the first such), around its first match; `field` is that field's index in `fields`.
 */
export function matchFields(fields: readonly string[], terms: string[]): (Snippet & { field: number }) | null {
  if (!terms.length) return null
  const texts = fields.map((text, field) => ({ text: plain(text), field })).filter(item => item.text)
  const all = fold(texts.map(item => item.text).join('\n')).folded
  if (!terms.every(term => all.includes(term))) return null
  let best: { text: string; field: number; spans: Span[]; count: number } | null = null
  for (const { text, field } of texts) {
    const folded = fold(text).folded
    const count = terms.filter(term => folded.includes(term)).length
    if (count && (!best || count > best.count)) best = { text, field, spans: occurrences(text, terms), count }
  }
  const { text, field, spans } = best!
  const first = spans[0]!
  // The cut never splits a character in two.
  let start = Math.max(0, first.start - BEFORE)
  if (start > 0 && lowHalf(text, start)) start--
  let end = Math.min(text.length, first.end + AFTER)
  if (end < text.length && lowHalf(text, end)) end--
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  const shift = head.length - start
  return {
    text: head + text.slice(start, end) + tail,
    marks: spans.filter(s => s.start >= start && s.end <= end).map(s => ({ start: s.start + shift, end: s.end + shift })),
    field,
  }
}

/** A snippet as the panel gets it (which field it came from left out). */
const snippetOf = ({ text, marks }: Snippet): Snippet => ({ text, marks })

/** Keeps the first `SEARCH_LIMIT` of `hits`, counting the rest. */
function cut<T>(hits: T[]): { list: T[]; more: number } {
  return { list: hits.slice(0, SEARCH_LIMIT), more: Math.max(0, hits.length - SEARCH_LIMIT) }
}

/** What the panel finds for `query`; nothing for a blank one. */
export function search(repo: Repo, query: string): SearchResults {
  const terms = termsOf(query)
  const tracks = repo.listTracks().filter(t => t.status !== 'archived')
  const tracksOf = new Map<Id, Track[]>()
  const products: Product[] = []
  for (const track of tracks) {
    for (const product of repo.productsOfTrack(track.id)) {
      if (!FOLLOWED.includes(product.status)) continue
      if (!tracksOf.has(product.id)) { tracksOf.set(product.id, []); products.push(product) }
      tracksOf.get(product.id)!.push(track)
    }
  }
  const productNotes = repo.notesOf('product', products.map(p => p.id))
  const productHits: SearchResults['products'] = []
  const cardHits: SearchResults['cards'] = []
  const findingHits: (SearchResults['findings'][number] & { at: string })[] = []
  for (const product of products) {
    const nameHit = matchFields([product.name, product.company, productNotes.get(product.id)?.text ?? ''], terms)
    if (nameHit) productHits.push({ id: product.id, name: product.name, company: product.company, tracks: tracksOf.get(product.id)!.map(t => t.name), inNote: nameHit.field === 2, snippet: snippetOf(nameHit) })
    const dimensions: Dimension[] = repo.dimensionsOfProduct(product.id)
    const cards = repo.latestCards(product.id)
    for (const dimension of dimensions) {
      const card = cards.find(c => c.dimension === dimension.key)
      const hit = card && matchFields([card.summary, ...card.bullets, card.body], terms)
      if (hit) cardHits.push({ productId: product.id, product: product.name, dimension: dimension.key, label: dimension.label, snippet: snippetOf(hit) })
    }
    const findings = repo.findingsOfProduct(product.id).filter(f => SHOWN.includes(f.status))
    const findingNotes = repo.notesOf('finding', findings.map(f => f.id))
    for (const finding of findings) {
      const hit = matchFields([finding.headline, finding.why, findingNotes.get(finding.id)?.text ?? ''], terms)
      if (hit) findingHits.push({ id: finding.id, productId: product.id, product: product.name, date: localDate(new Date(finding.createdAt)), headline: finding.headline, status: finding.status, inHeadline: hit.field === 0, inNote: hit.field === 2, snippet: snippetOf(hit), at: finding.createdAt })
    }
  }
  findingHits.sort((a, b) => b.at.localeCompare(a.at))
  const trackHits: SearchResults['tracks'] = tracks.flatMap(track => {
    const hit = matchFields([track.name, track.brief], terms)
    return hit ? [{ id: track.id, name: track.name, snippet: snippetOf(hit) }] : []
  })
  const topicHits: SearchResults['topics'] = tracks.flatMap(track => repo.topicsOfTrack(track.id).flatMap(topic => {
    const cards = repo.latestTopicVersion(topic.id)?.cards ?? []
    const hit = matchFields([topic.question, ...cards.flatMap(c => [c.title, c.summary, ...c.bullets, c.body])], terms)
    return hit ? [{ id: topic.id, question: topic.question, track: track.name, snippet: snippetOf(hit) }] : []
  }))
  const p = cut(productHits), t = cut(trackHits), c = cut(cardHits), f = cut(findingHits.map(({ at: _at, ...hit }) => hit)), tp = cut(topicHits)
  return {
    query, products: p.list, tracks: t.list, cards: c.list, findings: f.list, topics: tp.list,
    more: { products: p.more, tracks: t.more, cards: c.more, findings: f.more, topics: tp.more },
  }
}
