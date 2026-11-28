/** Domain types of Outpost. Pure data shapes: every later layer (store, jobs, tools, HTTP, panel) speaks in these. */

export type Id = string // crypto.randomUUID()

export type DimensionKey = string
export interface Dimension { key: DimensionKey; label: string }

export interface Track { id: Id; name: string; brief: string; dimensions: Dimension[]; status: 'picking' | 'active' | 'archived'; createdAt: string }

export type ProductStatus = 'candidate' | 'baselining' | 'tracking' | 'paused' | 'archived'
export interface Product { id: Id; name: string; company: string; region: 'domestic' | 'overseas'; form: string; iconPath: string | null; officialDomains: string[]; status: ProductStatus; dailyBudgetYuan: number | null; createdAt: string }

export interface Heat { foundCount: number; datedWeekly: number[]; trend: 'up' | 'flat' | 'down' | 'unknown'; showBars: boolean }
export type CandidateTier = 'strong' | 'consider' | 'excluded'
export interface Candidate { id: Id; trackId: Id; batchId: Id; productId: Id; tier: CandidateTier; oneLiner: string; reason: string; heat: Heat; selected: boolean }

export type SourceKind = 'official' | 'media' | 'review' | 'appstore' | 'social'
export type OpenedVia = 'http' | 'browser' | 'snippet' | 'unopened'
export interface Source { id: Id; url: string; title: string; publisher: string; publishedAt: string | null; kind: SourceKind
  /** What whoever handed it in said: the product's maker published it. Only a hint; `officialConfirmed` decides (`isOwnSource`). */
  isOfficial: boolean
  quote: string; syndicationGroup: string | null; openedVia: OpenedVia | null; quoteFound: boolean | null; supportsClaim: boolean | null
  /** What the checker said, having seen the page (M1.6): true, the maker published it; false, someone else did; null, not checked or could not tell. */
  officialConfirmed: boolean | null }

export type Importance = 'major' | 'notable' | 'minor'
export type ClaimKind = 'self' | 'third-party'
export type FindingStatus = 'pending' | 'verified' | 'unconfirmed' | 'unproven' | 'withdrawn'
export interface Finding { id: Id; productId: Id; runId: Id; headline: string; why: string; importance: Importance; claimKind: ClaimKind; sourceIds: Id[]; status: FindingStatus; statusNote: string | null; unconfirmedUntil: string | null; dimensions: DimensionKey[]; inference: boolean; read: boolean; late: boolean; dedupeKey: string; createdAt: string
  /** Local `YYYY-MM-DD` of the day the check first found it verified (the day being processed), or null; a promotion shows in that day's brief. */
  verifiedOn: string | null }

export interface Span { start: number; end: number }
export interface CardVersion { productId: Id; dimension: DimensionKey; version: number; summary: string; bullets: string[]; body: string; sourceIds: Id[]; inferenceSpans: Span[]; addedSpans: Span[]; changeNote: string; findingIds: Id[]; createdAt: string }
export interface CardEdit { id: Id; productId: Id; dimension: DimensionKey; summary: string; bullets: string[]; body: string; sourceIds: Id[]; inferenceSpans: Span[]; changeNote: string; findingIds: Id[]; status: 'pending' | 'applied' | 'rejected' }

export interface Facts { productId: Id; version: number; form: string; platforms: string; price: string; firstReleased: string; rivals: string[]; createdAt: string }

/** One axis of a track's map: what its low end (left, bottom) and its high end (right, top) stand for. */
export interface Axis { low: string; high: string }
export interface Axes { x: Axis; y: Axis }
/** Where the map puts a product: `x` and `y` from -100 (the low end) to 100 (the high end), and why, in a few words. */
export interface Placement { productId: Id; x: number; y: number; why: string }
/**
 * One drawing of a track's map (M2.1, design §5.5), with its one-sentence 格局 (`gist`). Every drawing is kept, so the
 * page can draw where a product stood at the first drawing on the same axes. All of it is the model's reading of the
 * dossiers: an inference, shown as one.
 */
export interface Landscape { id: Id; trackId: Id; date: string; gist: string; axes: Axes; positions: Placement[]; runId: Id | null
  /** When the dossiers it was drawn from were read (before the model was asked): cards written later are news to the next drawing. */
  createdAt: string }

/** 专题 (M2.3, design §5.6): one question looked into across some of a track's products, once or every week. */
export type TopicCadence = 'once' | 'weekly'
export interface Topic { id: Id; trackId: Id; question: string; productIds: Id[]; cadence: TopicCadence; createdAt: string }
/** One conclusion card of a 专题: like a dossier card, with a title of its own and the products it is about. */
export interface TopicCard { title: string; summary: string; bullets: string[]; body: string; sourceIds: Id[]; inferenceSpans: Span[]; productIds: Id[] }
/**
 * What one round of a 专题 handed in: a `draft` while it is researched and checked, then a `final` version (numbered from
 * 1, what the page shows) or `rejected` (nothing checked held; `changeNote` says why). A final's `changeNote` is what this
 * version changed, in the researcher's words.
 */
export type TopicVersionStatus = 'draft' | 'final' | 'rejected'
export interface TopicVersion { id: Id; topicId: Id; version: number | null; status: TopicVersionStatus; cards: TopicCard[]; changeNote: string; runId: Id | null; createdAt: string }

/** The user's own note (M3.3) on a product or a finding: one per thing, in their words; never read by research. */
export type NoteKind = 'product' | 'finding'
export interface Note { kind: NoteKind; subjectId: Id; text: string; updatedAt: string }

/** The AI's summary of a track's week (M3.4), written once the week is over; the rest of the recap is read from the data. */
export interface Recap { trackId: Id; week: string; gist: string; runId: Id | null; createdAt: string }

export interface Brief { date: string; gist: string; findingIds: Id[]; minorIds: Id[]; quietProductIds: Id[]
  /**
   * Tracked products not updated that day, with why. Without `failed` the budget stopped it (shown 「因预算未跑：…」);
   * with `failed: true` it ran and failed (shown 「未能更新：<产品>（<reason>）」, design §7.9).
   */
  skipped: { productId: Id; reason: string; failed?: true }[]
  costYuan: number; createdAt: string; updatedAt: string }

/**
 * `identify`: a product the user named by hand, confirmed before it joins their track (M1.2 按名字加). `landscape`: a
 * track's map and its one-sentence 格局, drawn by a model call (M2.1). `topic` and `topicCheck`: a 专题's research and its
 * check (M2.3).
 */
export type RunKind = 'recommend' | 'baseline' | 'daily' | 'verify' | 'synthesize' | 'followup' | 'identify' | 'landscape' | 'topic' | 'topicCheck' | 'recap'
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped'
/**
 * Tokens a model call used. `searches` counts the web searches made on a DeepSeek route: each is a hidden model call of its
 * own whose tokens DSH does not report, so it is priced as `SEARCH_TOKENS` (src/core/cost.ts). Absent means none.
 */
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; searches?: number }
export interface Run { id: Id; kind: RunKind; date: string; trackId: Id | null; productId: Id | null; sessionId: string | null; status: RunStatus; startedAt: string | null; endedAt: string | null; usage: Usage; costYuan: number; error: string | null; progress: { done: number; total: number } | null
  /** What the user typed that the run is about (the name of a product to confirm, for `identify`), or null. */
  subject: string | null }
