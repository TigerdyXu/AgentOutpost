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
  products: { id: Id; name: string; company: string; tracks: string[]; snippet: Snippet }[]
  tracks: { id: Id; name: string; snippet: Snippet }[]
  cards: { productId: Id; product: string; dimension: DimensionKey; label: string; snippet: Snippet }[]
  findings: { id: Id; productId: Id; product: string; date: string; headline: string; status: FindingStatus; snippet: Snippet }[]
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

/** `text` folded for matching, with the index in `text` of each folded character. */
function fold(text: string): { folded: string; at: number[] } {
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
      spans.push({ start: at[from]!, end: at[from + term.length] ?? text.length })
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

/** A field as it is searched: citation marks [n] dropped, line breaks as spaces. */
const plain = (text: string) => text.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim()

/**
 * The snippet of the thing's fields that `terms` all appear in, or null when one is missing: from the field holding the
 * most words (the first such), around its first match.
 */
export function matchFields(fields: readonly string[], terms: string[]): Snippet | null {
  if (!terms.length) return null
  const texts = fields.map(plain).filter(Boolean)
  const all = fold(texts.join('\n')).folded
  if (!terms.every(term => all.includes(term))) return null
  let best: { text: string; spans: Span[]; count: number } | null = null
  for (const text of texts) {
    const folded = fold(text).folded
    const count = terms.filter(term => folded.includes(term)).length
    if (count && (!best || count > best.count)) best = { text, spans: occurrences(text, terms), count }
  }
  const { text, spans } = best!
  const first = spans[0]!
  const start = Math.max(0, first.start - BEFORE)
  const end = Math.min(text.length, first.end + AFTER)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  const shift = head.length - start
  return {
    text: head + text.slice(start, end) + tail,
    marks: spans.filter(s => s.start >= start && s.end <= end).map(s => ({ start: s.start + shift, end: s.end + shift })),
  }
}

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
  const productHits: SearchResults['products'] = []
  const cardHits: SearchResults['cards'] = []
  const findingHits: (SearchResults['findings'][number] & { at: string })[] = []
  for (const product of products) {
    const nameHit = matchFields([product.name, product.company], terms)
    if (nameHit) productHits.push({ id: product.id, name: product.name, company: product.company, tracks: tracksOf.get(product.id)!.map(t => t.name), snippet: nameHit })
    const dimensions: Dimension[] = repo.dimensionsOfProduct(product.id)
    const cards = repo.latestCards(product.id)
    for (const dimension of dimensions) {
      const card = cards.find(c => c.dimension === dimension.key)
      const hit = card && matchFields([card.summary, ...card.bullets, card.body], terms)
      if (hit) cardHits.push({ productId: product.id, product: product.name, dimension: dimension.key, label: dimension.label, snippet: hit })
    }
    for (const finding of repo.findingsOfProduct(product.id)) {
      if (!SHOWN.includes(finding.status)) continue
      const hit = matchFields([finding.headline, finding.why], terms)
      if (hit) findingHits.push({ id: finding.id, productId: product.id, product: product.name, date: localDate(new Date(finding.createdAt)), headline: finding.headline, status: finding.status, snippet: hit, at: finding.createdAt })
    }
  }
  findingHits.sort((a, b) => b.at.localeCompare(a.at))
  const trackHits: SearchResults['tracks'] = tracks.flatMap(track => {
    const hit = matchFields([track.name, track.brief], terms)
    return hit ? [{ id: track.id, name: track.name, snippet: hit }] : []
  })
  const topicHits: SearchResults['topics'] = tracks.flatMap(track => repo.topicsOfTrack(track.id).flatMap(topic => {
    const cards = repo.latestTopicVersion(topic.id)?.cards ?? []
    const hit = matchFields([topic.question, ...cards.flatMap(c => [c.title, c.summary, ...c.bullets, c.body])], terms)
    return hit ? [{ id: topic.id, question: topic.question, track: track.name, snippet: hit }] : []
  }))
  const p = cut(productHits), t = cut(trackHits), c = cut(cardHits), f = cut(findingHits.map(({ at: _at, ...hit }) => hit)), tp = cut(topicHits)
  return {
    query, products: p.list, tracks: t.list, cards: c.list, findings: f.list, topics: tp.list,
    more: { products: p.more, tracks: t.more, cards: c.more, findings: f.more, topics: tp.more },
  }
}
