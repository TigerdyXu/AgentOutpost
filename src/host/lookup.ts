/**
 * `outpost_lookup` (M3.1): what any DSH chat of the user's can ask of Outpost. Given a product's or a track's name (and,
 * if wanted, a dimension), it answers with what the panel shows of it: a product's dossier (each dimension's conclusion
 * and bullets), the findings of the last 14 days the brief shows, the topics about it; a track's products, its latest map
 * and its topics. With a dimension, that dimension's full text and its numbered sources, so that the chat can cite them.
 * A name it cannot place gets the list of what Outpost follows instead, to ask again.
 *
 * It only reads: nothing is written, nothing is paid by Outpost (the chat's own model reads the answer). Research and check
 * sessions do not get it (`SessionDriver.share`); they have their own tools.
 */
import { z } from 'zod'
import { localDate } from '../core/calendar.ts'
import { DEFAULT_DIMENSION_EN } from '../core/dimensions.ts'
import { FOLLOWED, nameKey } from '../core/identity.ts'
import type { CardVersion, Dimension, Finding, Id, Product, Span, Topic, TopicCard, Track } from '../core/types.ts'
import type { Repo } from '../store/repo.ts'
import type { ToolSpec } from './ports.ts'
import { sessionTitle } from './titles.ts'

export const LOOKUP_TOOL = 'outpost_lookup'
/** Settings key: `true` when the user turned the tool off on 设置; it is offered unless they did. */
export const LOOKUP_OFF = 'lookupOff'

/** How far back a product's findings are shown (as `outpost_read`'s). */
const RECENT_DAYS = 14
/** At most this many of them, newest first. */
const MAX_FINDINGS = 20
/** A name shorter than this (after `nameKey`) is matched whole only: 「AI」 would be part of half of the names. */
const MIN_PART = 2

const LookupArgs = z.object({
  query: z.string().trim().min(1, { error: 'query 不能为空 / query is empty' }).max(60, { error: 'query ≤ 60' }),
  dimension: z.string().trim().max(60, { error: 'dimension ≤ 60' }).nullish(),
})
type LookupArgs = z.infer<typeof LookupArgs>

const DESCRIPTION = [
  '查前哨（Outpost）跟踪的产品和赛道的资料：核查过、带出处的档案（各维度的结论和要点）、近 14 天的动态、专题的结论、赛道的格局。',
  '用户问到前哨跟踪的产品或赛道时用它；回答时说明资料来自前哨、截至哪天（asOf）。',
  'query 填产品名或赛道名；要某个维度的全文和来源，再填 dimension（如「商业化」）。只读，不改前哨的任何东西。',
  'Look up what Outpost (前哨) has on a product or track it follows: checked, sourced dossier cards by dimension, the last 14 days of',
  'findings, topic conclusions, the track\'s landscape. Use it when the user asks about a product or track followed in Outpost, and say',
  'the answer comes from Outpost, as of `asOf`. query: a product or track name; add dimension (e.g. "Business model") for that',
  'dimension\'s full text and sources. Read-only. The content is in Chinese.',
].join('\n')

/** What the chat is told about reading the answer, once per answer. */
const NOTE = [
  '资料来自前哨：档案每句话都有出处，核查员打开原文核对过；inferences 里的句子是 AI 的推论；facts 是 AI 整理、未核查；map 是 AI 对格局的归纳。',
  'From Outpost: every sentence of a dossier card has a source a checker opened; sentences in `inferences` are the AI\'s own inference;',
  '`facts` are AI-compiled and unchecked; `map` is the AI\'s summary of the field. Findings: verified = checked; unconfirmed = its sources',
  'could not be opened yet. A body\'s [n] is source n; its `official`: true, the checker found the product\'s maker published it; false,',
  'someone else did; null, not known.',
].join(' ')

/** The tool, for `SessionDriver.share`. */
export function lookupTool(repo: Repo, now: () => Date): ToolSpec<typeof LookupArgs> {
  return {
    name: LOOKUP_TOOL, description: DESCRIPTION, schema: LookupArgs,
    execute: async args => lookup(repo, args, now()),
    title: args => sessionTitle(repo, 'lookup', { subject: args.dimension ? `${args.query} · ${args.dimension}` : args.query }),
  }
}

/** The answer to one call; see the module comment. */
export function lookup(repo: Repo, args: LookupArgs, now: Date): Record<string, unknown> {
  const asOf = localDate(now)
  const products = repo.listTracks().flatMap(t => repo.productsOfTrack(t.id))
    .filter((p, i, all) => FOLLOWED.includes(p.status) && all.findIndex(q => q.id === p.id) === i)
  const tracks = repo.listTracks().filter(t => t.status !== 'picking')
  // By name first; failing that, by company (「Meta」, 「蚂蚁」).
  let found = match(args.query, [
    ...products.map(p => ({ kind: 'product' as const, name: p.name, item: p as Product | Track })),
    ...tracks.map(t => ({ kind: 'track' as const, name: t.name, item: t as Product | Track })),
  ])
  if (!found.length) found = match(args.query, products.map(p => ({ kind: 'product' as const, name: p.company, item: p as Product | Track })))
  if (found.length === 0) {
    return {
      notFound: `前哨里没有叫「${args.query}」的产品或赛道。下面是前哨跟踪的，换个写法再查。/ Outpost follows nothing called "${args.query}"; it follows these.`,
      tracks: tracks.map(t => ({ name: t.name, products: repo.productsOfTrack(t.id).filter(p => FOLLOWED.includes(p.status)).map(p => p.name) })),
      asOf,
    }
  }
  if (found.length > 1) {
    return {
      ambiguous: `「${args.query}」对得上好几个，用其中一个的全名再查。/ Several match "${args.query}"; ask again by one full name.`,
      matches: found.map(f => f.kind === 'product' ? { kind: 'product', name: f.item.name, company: (f.item as Product).company } : { kind: 'track', name: f.item.name }),
      asOf,
    }
  }
  const [only] = found
  const dimension = args.dimension || null
  return only!.kind === 'product'
    ? { note: NOTE, asOf, ...productView(repo, only!.item as Product, dimension) }
    : { note: NOTE, asOf, ...trackView(repo, only!.item as Track, dimension) }
}

/**
 * The entries `query` names: those whose name reads the same (`nameKey`); failing that, those whose name is part of the
 * query or the query part of their name (a name of `MIN_PART` characters or more).
 */
function match<T extends { name: string }>(query: string, entries: T[]): T[] {
  const key = nameKey(query)
  const exact = entries.filter(e => nameKey(e.name) === key)
  if (exact.length) return exact
  return entries.filter(e => {
    const name = nameKey(e.name)
    return (name.length >= MIN_PART && key.includes(name)) || (key.length >= MIN_PART && name.includes(key))
  })
}

/** The dimensions of `dimensions` that `asked` names: by its label, its key, or (a default one) its English name. */
function dimensionOf(asked: string, dimensions: Dimension[]): Dimension[] {
  const names = (d: Dimension) => [d.label, d.key, ...DEFAULT_DIMENSION_EN[d.key] ? [DEFAULT_DIMENSION_EN[d.key]!] : []]
  return match(asked, dimensions.flatMap(d => names(d).map(name => ({ name, d }))))
    .map(m => m.d)
    .filter((d, i, all) => all.indexOf(d) === i)
}

/** `text`'s sentences at `spans`: what a card marks as inference. */
const spansOf = (text: string, spans: Span[]) => spans.map(s => text.slice(s.start, s.end)).filter(Boolean)

/** A card's sources, numbered as its body cites them ([n] is the n-th id); one since deleted keeps its number, unlisted. */
function sourcesOf(repo: Repo, ids: Id[]) {
  const byId = new Map(repo.getSources(ids).map(s => [s.id, s]))
  return ids.flatMap((id, i) => {
    const s = byId.get(id)
    return s ? [{ n: i + 1, publisher: s.publisher, title: s.title, url: s.url, date: s.publishedAt, official: s.officialConfirmed }] : []
  })
}

/** One dossier card: its conclusion and bullets; with `full`, its text, inferences and sources too. */
function cardView(repo: Repo, card: CardVersion, label: string, full: boolean) {
  return {
    dimension: label, summary: card.summary, bullets: card.bullets, updated: card.createdAt.slice(0, 10),
    ...full ? { body: card.body, inferences: spansOf(card.body, card.inferenceSpans), sources: sourcesOf(repo, card.sourceIds) } : {},
  }
}

/** A topic's question and the conclusions of its latest version (only the cards about `productId`, when given and some are). */
function topicView(repo: Repo, tracks: Track[], topic: Topic, productId?: Id) {
  const version = repo.latestTopicVersion(topic.id)
  const about = (c: TopicCard) => productId === undefined || c.productIds.includes(productId)
  const cards = version ? (version.cards.some(about) ? version.cards.filter(about) : version.cards) : []
  return {
    question: topic.question,
    track: tracks.find(t => t.id === topic.trackId)?.name ?? null,
    version: version?.version ?? null,
    date: version?.createdAt.slice(0, 10) ?? null,
    conclusions: cards.map(c => ({ title: c.title, summary: c.summary, bullets: c.bullets })),
  }
}

function findingView(f: Finding) {
  return { date: f.createdAt.slice(0, 10), headline: f.headline, why: f.why, importance: f.importance, status: f.status }
}

function productView(repo: Repo, product: Product, asked: string | null) {
  const dimensions = repo.dimensionsOfProduct(product.id)
  const cards = repo.latestCards(product.id)
  const label = (key: string) => dimensions.find(d => d.key === key)?.label ?? key
  const facts = repo.latestFacts(product.id)
  const head = {
    product: {
      name: product.name, company: product.company, status: product.status,
      tracks: repo.listTracks().filter(t => repo.productsOfTrack(t.id).some(p => p.id === product.id)).map(t => t.name),
      since: product.createdAt.slice(0, 10),
      updated: cards.reduce<string | null>((latest, c) => latest && latest > c.createdAt ? latest : c.createdAt, null)?.slice(0, 10) ?? null,
    },
  }
  if (asked) {
    const chosen = dimensionOf(asked, dimensions)
    if (chosen.length !== 1) {
      return { ...head, dimensionNotFound: `「${asked}」${chosen.length ? '对得上好几个维度' : '不是这个产品的维度'}。/ "${asked}" ${chosen.length ? 'matches several dimensions' : 'is not one of its dimensions'}.`, dimensions: dimensions.map(d => d.label) }
    }
    const card = cards.find(c => c.dimension === chosen[0]!.key)
    return { ...head, dossier: card ? [cardView(repo, card, chosen[0]!.label, true)] : [], ...card ? {} : { empty: '这个维度还没有档案。/ No card in this dimension yet.' } }
  }
  const shown = repo.findingsOfProduct(product.id, RECENT_DAYS).filter(f => f.status === 'verified' || f.status === 'unconfirmed').slice(0, MAX_FINDINGS)
  return {
    ...head,
    facts: facts && { form: facts.form, platforms: facts.platforms, price: facts.price, firstReleased: facts.firstReleased, rivals: facts.rivals },
    dossier: dimensions.flatMap(d => {
      const card = cards.find(c => c.dimension === d.key)
      return card ? [cardView(repo, card, label(d.key), false)] : []
    }),
    recentFindings: shown.map(findingView),
    topics: repo.topicsOfProduct(product.id).map(t => topicView(repo, repo.listTracks(), t, product.id)),
  }
}

function trackView(repo: Repo, track: Track, asked: string | null) {
  const products = repo.productsOfTrack(track.id).filter(p => FOLLOWED.includes(p.status))
  const head = { track: { name: track.name, brief: track.brief, archived: track.status === 'archived', dimensions: track.dimensions.map(d => d.label) } }
  if (asked) {
    const chosen = dimensionOf(asked, track.dimensions)
    if (chosen.length !== 1) {
      return { ...head, dimensionNotFound: `「${asked}」${chosen.length ? '对得上好几个维度' : '不是这个赛道的维度'}。/ "${asked}" ${chosen.length ? 'matches several dimensions' : 'is not one of its dimensions'}.` }
    }
    const d = chosen[0]!
    return {
      ...head,
      dimension: d.label,
      products: products.map(p => {
        const card = repo.latestCards(p.id).find(c => c.dimension === d.key)
        return { name: p.name, company: p.company, status: p.status, card: card ? cardView(repo, card, d.label, true) : null }
      }),
    }
  }
  const map = repo.latestLandscape(track.id)
  return {
    ...head,
    products: products.map(p => {
      const positioning = repo.latestCards(p.id).find(c => c.dimension === 'positioning') ?? null
      return { name: p.name, company: p.company, status: p.status, positioning: positioning?.summary ?? null }
    }),
    map: map && { date: map.date, gist: map.gist, axes: map.axes, aiSummary: true },
    topics: repo.topicsOfTrack(track.id).map(t => topicView(repo, [track], t)),
  }
}
