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
export interface Source { id: Id; url: string; title: string; publisher: string; publishedAt: string | null; kind: SourceKind; isOfficial: boolean; quote: string; syndicationGroup: string | null; openedVia: OpenedVia | null; quoteFound: boolean | null; supportsClaim: boolean | null }

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

export interface Brief { date: string; gist: string; findingIds: Id[]; minorIds: Id[]; quietProductIds: Id[]
  /**
   * Tracked products not updated that day, with why. Without `failed` the budget stopped it (shown 「因预算未跑：…」);
   * with `failed: true` it ran and failed (shown 「未能更新：<产品>（<reason>）」, design §7.9).
   */
  skipped: { productId: Id; reason: string; failed?: true }[]
  costYuan: number; createdAt: string; updatedAt: string }

export type RunKind = 'recommend' | 'baseline' | 'daily' | 'verify' | 'synthesize' | 'followup'
export type RunStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped'
export interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number }
export interface Run { id: Id; kind: RunKind; date: string; trackId: Id | null; productId: Id | null; sessionId: string | null; status: RunStatus; startedAt: string | null; endedAt: string | null; usage: Usage; costYuan: number; error: string | null; progress: { done: number; total: number } | null }
