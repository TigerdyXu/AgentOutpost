/**
 * The panel's API under `/outpost/api/`: the route table (`createApi`) and its contract (`Api`), which the client imports
 * with `import type` only. Each entry names its query, body and response; `:name` segments are the route's params.
 *
 * Rules every route keeps: request bodies are checked with zod (a bad or over-long field is a 400 naming it); an id that
 * names nothing is a 404; a request that cannot be done in the current state is a 409 with a sentence the panel shows.
 */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { unreadCount } from '../core/brief.ts'
import { localDate } from '../core/calendar.ts'
import { DEFAULT_DIMENSIONS, slugDimension } from '../core/dimensions.ts'
import { FOLLOWED, hasNameKey, nameKey } from '../core/identity.ts'
import type { Billing, ModelRef } from '../core/models.ts'
import type {
  Brief, Candidate, CardVersion, Dimension, DimensionKey, Facts, Finding, Id, Product, ProductStatus, Run, RunStatus, Source, Track,
} from '../core/types.ts'
import { listModelGroups } from './dsh-model.ts'
import { startFollowup } from './followup.ts'
import { ApiError, matchRoute, RawReply, type ApiRequestParts } from './http.ts'
import { ICON_TYPES } from './icons.ts'
import { CHECK_NOT_DONE } from './jobs/daily.ts'
import { startIdentify } from './jobs/identify.ts'
import { startRecommendation } from './jobs/recommend.ts'
import { joinTrack, type Joined } from './join.ts'
import type { Runtime } from './runtime.ts'

// ---- the contract ----

/** One tracked product in the middle column. */
export interface TrackProductView {
  product: Product
  /** It has an unread finding in today's brief (the blue dot). */
  hasNew: boolean
  /** The progress of its baseline while one runs (建档中), else null. */
  progress: Run['progress']
}
export interface TrackView {
  track: Track
  products: TrackProductView[]
  /** Candidates of the track's latest batch that wait to be looked at (not those the user had seen when they started tracking from it; later ones count). */
  candidatesToReview: number
  /** The track's latest recommendation is queued or running: what the panel reads the state quickly for (a track merely being picked is not). */
  recommending: boolean
}
export interface StateView {
  tracks: TrackView[]
  todayDate: string
  /** Unread findings shown in today's brief (the sidebar number): its main list, verified or 「待确认」, not read. */
  todayUnread: number
  todayCostYuan: number
  /** When the daily run is due (`HH:MM`, local), as configured: the page that waits for the first brief names it. */
  runTime: string
  /** A browser provider is registered with DSH's browser use, so pages behind verification walls can be opened. */
  browserAvailable: boolean
  /** The research preset cannot compose a session (`Runtime.researchProblem`): no research runs at all until it is fixed. */
  researchBroken: boolean
  /** The data directory in use (database, icons, working files), for 设置 to show; it cannot be changed while Outpost runs. */
  dataDir: string
}
export interface BriefView {
  brief: Brief | null
  /**
   * The findings of the brief that are still shown (verified or 「待确认」), main and minor. An id of the brief without a
   * finding here (withdrawn or unproven since) is not shown.
   */
  findings: Finding[]
  /** Every product the brief names: in its findings, quiet or skipped. */
  products: Product[]
  /** The sources of `findings`. */
  sources: Source[]
  /** For each of `findings` that changed the profile, the dimensions it changed (`changedBy`). */
  changed: Record<Id, DimensionKey[]>
  /** The latest earlier day with a brief (「‹ 昨天」), or null. */
  prevDate: string | null
}
export interface CandidatesView {
  /** The latest recommendation of the track (its run id), or null when it never had one. */
  batchId: Id | null
  running: boolean
  /** That run's status, and why it was skipped or failed (「今日总预算已用完」, say): what explains an empty list. Null without a run. */
  status: RunStatus | null
  error: string | null
  /** How long the recommendation has run, or ran, in whole seconds. */
  elapsedSec: number
  /**
   * `trackedIn`: the names of the other tracks (archived ones aside) that Outpost already follows the candidate's product
   * in, in the order the tracks are listed: the product itself, or another row that reads alike (`findSameProduct`), tracked,
   * paused or in 建档中. Empty for a product no other track follows. A product runs once a day whatever its tracks.
   * `trackedStatus`: with `trackedIn`, the status of the followed product that 开始跟踪 would put in this track (the
   * candidate's product, or for a candidate row its twin): a paused one neither runs nor gets the missing dimensions. Null
   * when `trackedIn` is empty.
   */
  candidates: (Candidate & { product: Product; trackedIn: string[]; trackedStatus: FollowedStatus | null })[]
}
/** The statuses of a product Outpost follows (`FOLLOWED`). */
export type FollowedStatus = Extract<ProductStatus, 'tracking' | 'paused' | 'baselining'>
export interface ProductView {
  product: Product
  facts: Facts | null
  /** The newest version of each dimension's card. */
  cards: CardVersion[]
  /** Every version of each of the product's dimensions (and of any other dimension it has a card for), oldest first. */
  history: Record<DimensionKey, { version: number; changeNote: string; createdAt: string }[]>
  /** The sources the cards cite. */
  sources: Source[]
  dimensions: Dimension[]
  progress: Run['progress']
}
export type RunRow = Run & { productName: string | null }
/** The models DSH offers now, for the four model choices of 设置. */
export interface ModelsView {
  /** One group per provider, in DSH's order. */
  groups: {
    provider: string
    /** DSH's name for the provider: the group's title. */
    name: string
    /** How its use is counted: by the price table (`metered`), or ¥0 (`local`, `subscription`). */
    billing: Billing
    models: { id: string; name: string }[]
    /** 「读取失败」 when the provider did not list its models in time, or failed to; `models` is then empty. */
    error: string | null
  }[]
  /** DSH's default model (what research runs on with no model chosen), or null when DSH cannot say. */
  defaultModel: ModelRef | null
}

/** The API, route by route. A done run's `error` is a note (it finished, with that remark), not a failure. */
export interface Api {
  'GET health': { response: { ok: true } }
  'GET state': { response: StateView }
  'GET brief': { query?: { date?: string }; response: BriefView }
  'POST findings/:id/read': { response: { ok: true } }
  /** Marks every finding of that day's brief read. */
  'POST brief/read-all': { body: { date: string }; response: { ok: true } }
  /** Creates the track (status `picking`; dimensions: the six defaults, then the custom ones) and starts its recommendation. */
  'POST tracks': { body: { name: string; brief: string; extraDimensions: string[] }; response: { trackId: Id; batchId: Id } }
  /**
   * `extraDimensions` replaces the custom dimensions; a label the track keeps keeps its key. A dimension added is filled in
   * at once for the track's tracked products that lack its card.
   */
  'PATCH tracks/:id': { body: { name?: string; brief?: string; extraDimensions?: string[] }; response: Track }
  /** A new batch, with the user's one-sentence adjustment; 409 while the previous one still runs. */
  'POST tracks/:id/recommend': { body?: { refine?: string }; response: { batchId: Id } }
  'GET tracks/:id/candidates': { response: CandidatesView }
  /**
   * The track becomes `active`, the chosen products join it, and those new to Outpost are baselined (建档中); a tracked one
   * that the track gives dimensions it lacks gets their cards at once.
   */
  'POST tracks/:id/start': { body: { candidateIds: Id[] }; response: { ok: true } }
  /**
   * Adds a product to the track by its name (and official site, if known). When exactly one product Outpost follows has
   * that name (`findFollowedByName`: width, case, spaces and punctuation aside), it joins at once, as 开始跟踪 joins it,
   * without a run: `linked` is its id and `status` how it stands (a tracked one gets the cards of the dimensions this track
   * adds; a paused one stays paused, with nothing filled in); `already` says it was in the track before, and nothing
   * changed. Otherwise a confirmation starts (`identify`, see `startIdentify`), and `runId` is its run: once over, the run
   * names the product that joined (`productId`), or says why none did (`error`). While a confirmation of the same name
   * (by `nameKey`) for the track is queued or running, `runId` is that one and nothing new starts. A blank official site is
   * one not given. 409 「这个赛道已归档」 for an archived track.
   */
  'POST tracks/:id/add-product': { body: { name: string; officialUrl?: string }; response: { linked: Id; status: FollowedStatus; already?: true } | { runId: Id } }
  /**
   * 「也加到其他赛道」: the product joins the track and stays in its others, as `POST tracks/:id/start` joins a product that
   * is followed already (`joinTrack`): its dossier and history are kept and only the cards for what the track adds are
   * asked for, at once, after its daily run or baseline if one is in flight. `toppedUp` is how many cards that is (0: none,
   * and none for a paused product, which is linked as it is). The product runs once a day however many tracks it is in.
   * 409 for a product that is not followed, a track that is unknown or archived, and a product that is in the track already.
   */
  'POST products/:id/link': { body: { trackId: Id }; response: { toppedUp: number } }
  /**
   * 「从X拿掉」: the product leaves the track. Its cards and their history stay stored, so nothing is lost; the product
   * page shows only the dimensions that some track the product is still in lists, so the cards of a dimension only that
   * track had are hidden, and show again if the product joins a track that lists the dimension. 409 when no other track
   * that is on (not archived) would keep it (「这是它唯一的赛道。不想跟了就用「暂停跟踪」。」), and for a track the product is
   * not in.
   */
  'POST products/:id/unlink': { body: { trackId: Id }; response: { ok: true } }
  /**
   * 「移到其他赛道」: `link` to `to` and `unlink` from `from`, in one transaction (the joining first, so that a failure
   * leaves the product in `from`). The answer and the 409s are `link`'s (an unknown, archived or already-joined `to`, a
   * product that is not followed), and 409 too for a `from` the product is not in. There is no 「唯一的赛道」 refusal as
   * `unlink` has: the product is in `to`, which is not archived, when it leaves `from`. What `unlink` says of the cards
   * of a dimension only `from` had holds here too: kept, hidden on the product page, shown again by a track that lists
   * them. A paused product stays paused.
   */
  'POST products/:id/move': { body: { from: Id; to: Id }; response: { toppedUp: number } }
  'GET products/:id': { response: ProductView }
  /** The product's findings, newest first: verified, 「待确认」 and unproven ones (not those unchecked or withdrawn). */
  'GET products/:id/findings': { response: { findings: Finding[]; sources: Source[]; changed: Record<Id, DimensionKey[]> } }
  'PATCH products/:id': { body: { status?: 'tracking' | 'paused'; dailyBudgetYuan?: number | null }; response: Product }
  /** 「立即更新」: answers at once with the run it started (a baseline first, if a card is missing), or the one in flight. */
  'POST products/:id/update-now': { response: { runId: Id } }
  /** The icon's bytes, for `<img src="/outpost/api/icons/<id>">` (not for `call`); 404 when there is none. */
  'GET icons/:productId': { response: Blob }
  /** Opens the 追问 chat in DSH; the panel then opens the session. */
  'POST followup': { body: { findingId: Id }; response: { sessionId: string } }
  /** The runs of the last `days` days (today counts as one), newest first. */
  'GET runs': { query?: { days?: number }; response: { runs: RunRow[] } }
  /**
   * Runs a failed run's work again and answers with the new run: a failed check of a tracked product, or its update that
   * failed only because the check did not finish, as that check alone, for its day. 409 「已经重新跑过了」 when that work was done again since (a later run of the same work, a finished
   * update of the product that day, a newer batch of the track).
   */
  'POST runs/:id/retry': { response: { runId: Id } }
  /**
   * The providers of DSH with their models, asked anew each time (each within 5 seconds), and DSH's default model. A model
   * saved in the configuration that is missing here is not changed; 设置 marks it 「当前不可用」.
   */
  'GET models': { response: ModelsView }
}

type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
/** The `:name` params of a route, by name. */
export type RouteParams<K extends keyof Api> = Params<Path<K>>
/** What a caller passes for a route: its params, and its `query` and `body` if it has them. */
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']

// ---- limits ----

const MAX_NAME = 20
/** A product's name, as the agent may hand one in (`outpost_submit_candidate`). */
const MAX_PRODUCT_NAME = 30
const MAX_URL = 500
const MAX_BRIEF = 100
const MAX_REFINE = 60
const MAX_DIMENSION_LABEL = 20
/** Custom dimensions per track: with the six defaults, a track has at most 20 (as many as a finding may name). */
const MAX_EXTRA_DIMENSIONS = 14
const MAX_START = 100
const MAX_RUN_DAYS = 90

const text = (max: number) => z.string().trim().max(max)
const label = z.string().trim().min(1, '维度名不能为空').max(MAX_DIMENSION_LABEL)
const NewTrack = z.object({ name: text(MAX_NAME).min(1), brief: text(MAX_BRIEF).default(''), extraDimensions: z.array(label).max(MAX_EXTRA_DIMENSIONS).default([]) })
const TrackPatch = z.object({ name: text(MAX_NAME).min(1).optional(), brief: text(MAX_BRIEF).optional(), extraDimensions: z.array(label).max(MAX_EXTRA_DIMENSIONS).optional() })
const Recommend = z.object({ refine: text(MAX_REFINE).optional() })
const Start = z.object({ candidateIds: z.array(z.string().min(1)).min(1).max(MAX_START) })
const AddProduct = z.object({
  // A name of nothing but spaces and punctuation (「!!!」) is no name: the same complaint as an empty one, before a paid confirmation starts.
  name: text(MAX_PRODUCT_NAME).min(1).refine(hasNameKey, '请填产品名'),
  officialUrl: z.preprocess(value => value === null || (typeof value === 'string' && !value.trim()) ? undefined : value,
    z.string().trim().max(MAX_URL).url({ protocol: /^https?$/, error: 'officialUrl must be an http:// or https:// address' }).optional()),
})
const ProductPatch = z.object({ status: z.enum(['tracking', 'paused']).optional(), dailyBudgetYuan: z.number().min(0).max(100_000).nullable().optional() })
const TrackRef = z.object({ trackId: z.string().min(1) })
const Move = z.object({ from: z.string().min(1), to: z.string().min(1) })
const Followup = z.object({ findingId: z.string().min(1) })
const ReadAll = z.object({ date: z.string() })

/** `YYYY-MM-DD` naming a day that exists. */
function day(value: string | undefined, field: string): string {
  const m = value === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null
  if (!m || !d || d.toISOString().slice(0, 10) !== value) throw new ApiError(400, `${field} must be a date written YYYY-MM-DD`)
  return value!
}

/** The local date `days` days after `date` (both `YYYY-MM-DD`). */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return localDate(new Date(y!, m! - 1, d! + days))
}

/** Why a product cannot be taken out of its only track. */
const ONLY_TRACK = '这是它唯一的赛道。不想跟了就用「暂停跟踪」。'
const isShown = (f: Finding) => f.status === 'verified' || f.status === 'unconfirmed'
const isActive = (r: Run) => r.status === 'queued' || r.status === 'running'
/** Kinds of run that work on one product: what 「立即更新」 and a retry of them start, and wait for. */
const PRODUCT_WORK = new Set<Run['kind']>(['baseline', 'daily', 'verify'])
/**
 * Settings key, per track: the candidates of the latest batch that the user had in front of them when they started tracking
 * from it (`Reviewed`). The ones they passed over are not waiting to be looked at; those the batch's still-running round adds
 * afterwards are, so starting early loses nothing. (A candidate found in the instant between the panel's last read and the
 * click counts as seen: at most one polling interval of candidates.)
 */
const reviewedKey = (trackId: Id) => `reviewedCandidates:${trackId}`
interface Reviewed { batchId: Id; candidateIds: Id[] }

// ---- dimensions ----

const sameLabel = (label: string) => label.normalize('NFKC').trim().toLowerCase()

/**
 * The dimensions of a track: the six defaults, then each custom label once, in the order given. A label that equals one
 * already in the list (ignoring case and width) is that dimension, not another. Each custom one keeps the key the same
 * label has in this track or another track (one dimension, one card, for a product in both); a new one gets
 * `slugDimension` of its label, with `-2`, `-3`… appended while that key is a default's, another dimension's of any
 * track, or one some card was written under (a removed dimension's cards must not turn up under a new label).
 */
function trackDimensions(rt: Runtime, labels: string[]): Dimension[] {
  const dimensions: Dimension[] = [...DEFAULT_DIMENSIONS]
  const labelsHere = new Set(dimensions.map(d => sameLabel(d.label)))
  const keyOfLabel = new Map<string, DimensionKey>()
  const taken = new Set<DimensionKey>([...DEFAULT_DIMENSIONS.map(d => d.key), ...rt.repo.cardDimensions()])
  for (const track of rt.repo.listTracks()) {
    for (const d of track.dimensions) {
      taken.add(d.key)
      if (!keyOfLabel.has(sameLabel(d.label))) keyOfLabel.set(sameLabel(d.label), d.key)
    }
  }
  const usedHere = new Set(dimensions.map(d => d.key))
  for (const raw of labels) {
    const label = raw.trim()
    if (labelsHere.has(sameLabel(label))) continue
    labelsHere.add(sameLabel(label))
    let key = keyOfLabel.get(sameLabel(label))
    if (key === undefined || usedHere.has(key)) {
      const base = slugDimension(label)
      key = base
      for (let n = 2; taken.has(key) || usedHere.has(key); n++) key = `${base}-${n}`
      taken.add(key)
    }
    usedHere.add(key)
    dimensions.push({ key, label })
  }
  return dimensions
}

// ---- the routes ----

type Handler<K extends keyof Api> = (req: ApiRequestParts) => Promise<ApiResponse<K> | RawReply> | ApiResponse<K> | RawReply

/**
 * The handler of `registerRoutes` for the panel's API: finds the route of `<METHOD> <path>` (`matchRoute`) and answers it.
 * @param rt - the running Outpost.
 */
export function createApi(rt: Runtime): (route: string, req: ApiRequestParts) => Promise<unknown> {
  const { repo } = rt

  const track = (id: string) => repo.listTracks().find(t => t.id === id) ?? notFound('找不到这个赛道')
  const product = (id: string) => repo.getProduct(id) ?? notFound('找不到这个产品')
  const products = (ids: Iterable<Id>) => [...new Set(ids)].flatMap(id => repo.getProduct(id) ?? [])
  /** The newest baseline of the product that still runs: its progress is what 建档中 shows. */
  const progressOf = (productId: Id, active: Run[]) => active.find(r => r.productId === productId && r.kind === 'baseline')?.progress ?? null
  const recommending = (trackId: Id) => { const run = repo.latestRun('recommend', { trackId }); return run !== null && isActive(run) }
  /**
   * Tracked, or in 建档中: what a new dimension is filled in for at once (a baseline running for a product in 建档中 was
   * asked for the dimensions it knew when it started; `topUpNow` asks for the rest once it is over).
   */
  const isWorkedOn = (p: Product) => p.status === 'tracking' || p.status === 'baselining'
  /**
   * The names of the tracks among `others` that follow the product (`trackedIn`): it, or another row that reads alike,
   * tracked, paused or in 建档中, is one of their products. A candidate row of its own for a product tracked elsewhere
   * (「千问Go」 beside 「千问Go!」) is told as that product is. With them, the status of the row 开始跟踪 would link
   * (`trackedStatus`: the product itself, or for a candidate or archived row its twin, as `POST tracks/:id/start` picks it).
   */
  const trackedElsewhere = (p: Product, others: { name: string; products: Set<Id> }[]): { trackedIn: string[]; trackedStatus: FollowedStatus | null } => {
    const twin = repo.findSameProduct(p)
    const followed = [p, twin].flatMap(row => row && FOLLOWED.includes(row.status) ? [row.id] : [])
    const trackedIn = others.filter(other => followed.some(id => other.products.has(id))).map(other => other.name)
    const joining = p.status === 'candidate' || p.status === 'archived' ? twin : p
    const status = joining && FOLLOWED.includes(joining.status) ? joining.status as FollowedStatus : null
    return { trackedIn, trackedStatus: trackedIn.length ? status : null }
  }
  /** The tracks the product is in, in the order they are listed. */
  const tracksOf = (productId: Id) => repo.listTracks().filter(t => repo.productsOfTrack(t.id).some(p => p.id === productId))
  /**
   * The track that `p` may join (`link`, `move`).
   * @throws 409 when the product is not one Outpost follows, or the track is unknown or archived or has the product already.
   */
  const joinableTrack = (p: Product, trackId: Id): Track => {
    if (!FOLLOWED.includes(p.status)) throw new ApiError(409, '这个产品没有在跟踪')
    const target = repo.listTracks().find(t => t.id === trackId)
    if (!target) throw new ApiError(409, '找不到这个赛道')
    if (target.status === 'archived') throw new ApiError(409, '这个赛道已归档')
    if (repo.productsOfTrack(target.id).some(here => here.id === p.id)) throw new ApiError(409, '它已经在这个赛道里了')
    return target
  }
  /** How many cards a product that joined a track is asked for at once: those it lacks, if it is worked on (not paused). */
  const toppedUp = (joined: Joined | undefined) => joined?.work === 'top-up' ? joined.missing.length : 0
  /** Whether the product has no card yet for one of `keys`. */
  const lacksCard = (productId: Id, keys: DimensionKey[]) => {
    const have = new Set(repo.latestCards(productId).map(c => c.dimension))
    return keys.some(key => !have.has(key))
  }

  /** Today's brief, and its main findings that are still shown, by id. */
  const today = () => {
    const brief = repo.getBrief(rt.today())
    const shown = new Map<Id, Finding>()
    for (const id of brief?.findingIds ?? []) {
      const f = repo.getFinding(id)
      if (f && isShown(f)) shown.set(id, f)
    }
    return { brief, shown }
  }

  const candidatesToReview = (t: Track): number => {
    const batch = repo.latestBatchId(t.id)
    if (batch === null || t.status === 'archived') return 0
    const reviewed = t.status === 'active' ? repo.getSetting<Reviewed>(reviewedKey(t.id)) : undefined
    const seen = new Set(reviewed?.batchId === batch ? reviewed.candidateIds : [])
    const linked = new Set(repo.productsOfTrack(t.id).map(p => p.id))
    return repo.listCandidates(t.id, batch).filter(c => c.tier !== 'excluded' && !linked.has(c.productId) && !seen.has(c.id)).length
  }

  /**
   * Calls `start` and answers with the first run matching `match` that did not exist before, looking again on each of the
   * next few turns of the event loop (the jobs create their run before their first wait, but some only after a short
   * chain of steps); null if none turns up. Runs dated before `since` (default: yesterday) are not looked at, so work
   * counted toward an earlier day (a brief's summary is dated with the brief) must say so.
   */
  const startedRun = async (match: (r: Run) => boolean, start: () => void, since = shiftDate(rt.today(), -1)): Promise<Id | null> => {
    const before = new Set(repo.listRuns(since).filter(match).map(r => r.id))
    start()
    for (let turn = 0; turn < 50; turn++) {
      const fresh = repo.listRuns(since).filter(r => match(r) && !before.has(r.id))
      if (fresh.length) return fresh.at(-1)!.id // listed newest first: the first one it started
      await new Promise(resolve => setImmediate(resolve))
    }
    return null
  }

  /**
   * Starts work on the product unless some is in flight, and answers with the run in flight, else the first run `start`
   * made, else (a baseline with nothing left to do but settle, say) the product's latest run of that work. Runs dated
   * before `since` (default: yesterday) are not looked at, as in `startedRun`.
   */
  const productWork = async (p: Product, start: () => Promise<unknown>, label: string, since = shiftDate(rt.today(), -1)): Promise<Id> => {
    const ofProduct = (r: Run) => r.productId === p.id && PRODUCT_WORK.has(r.kind)
    const active = repo.activeRuns(p.id).find(ofProduct)
    if (active) return active.id
    const runId = await startedRun(ofProduct, () => { rt.background(start(), label) }, since)
    const latest = runId ?? repo.listRuns(since).find(ofProduct)?.id
    if (latest === undefined) throw new Error(`${label} started no run`)
    return latest
  }
  /** 「立即更新」 of a tracked (or 建档中) product, through the scheduler so that it never runs beside the day's work on it. */
  const updateNow = (p: Product) => productWork(p, () => rt.scheduler.runProductNow(p.id), `update of product ${p.id}`)
  /** The product's baseline again (what it lacks), through the scheduler likewise. */
  const baselineNow = (p: Product) => productWork(p, () => rt.scheduler.baseline([p.id]), `baseline of product ${p.id}`)
  /** The product's check alone, counted toward `date`, through the scheduler likewise (重试 of a failed check). */
  const checkNow = (p: Product, date: string) => {
    const yesterday = shiftDate(rt.today(), -1)
    return productWork(p, () => rt.scheduler.recheck(p.id, date), `check of product ${p.id}`, date < yesterday ? date : yesterday)
  }

  /**
   * Whether the work of a failed run was done again since, so that 重试 would pay for it twice: for a daily update or a
   * check, the product has a daily run of that day that is done, or a later run of the same kind that day (the scheduler
   * tries a failed product once more and resumes an interrupted one; that later run is the one to retry if it failed
   * too); for a recommendation, the track has a newer batch.
   */
  const redone = (run: Run): boolean => {
    if (run.kind === 'recommend') return run.trackId !== null && repo.latestRun('recommend', { trackId: run.trackId })?.id !== run.id
    if (run.kind !== 'daily' && run.kind !== 'verify') return false
    const day = repo.runsOfDate(run.date).filter(r => r.productId === run.productId)
    const later = day.slice(day.findIndex(r => r.id === run.id) + 1)
    return day.some(r => r.kind === 'daily' && r.status === 'done') || later.some(r => r.kind === run.kind)
  }

  /**
   * The dimensions each finding changed (「改了档案：…」, 看改动): those with a card version that rests on it. What the agent
   * says a finding affects (`Finding.dimensions`) is only a claim; an edit the check rejected changed nothing. The ones it
   * names come first, in its order, then the others in the product's order. Findings that changed nothing are left out.
   */
  const changedBy = (findings: Finding[]): Record<Id, DimensionKey[]> => {
    const wanted = new Set(findings.map(f => f.id))
    const found = new Map<Id, Set<DimensionKey>>()
    for (const productId of new Set(findings.map(f => f.productId))) {
      const keys = new Set([...repo.dimensionsOfProduct(productId).map(d => d.key), ...repo.latestCards(productId).map(c => c.dimension)])
      for (const key of keys) {
        for (const version of repo.cardHistory(productId, key)) {
          for (const id of version.findingIds) if (wanted.has(id)) found.set(id, (found.get(id) ?? new Set()).add(key))
        }
      }
    }
    const out: Record<Id, DimensionKey[]> = {}
    for (const f of findings) {
      const keys = found.get(f.id)
      if (!keys) continue
      out[f.id] = [...f.dimensions.filter(key => keys.has(key)), ...[...keys].filter(key => !f.dimensions.includes(key))]
    }
    return out
  }

  const table: { [K in keyof Api]: Handler<K> } = {
    'GET health': () => ({ ok: true }),

    'GET state': async () => {
      const researchBroken = (await rt.researchProblem()) !== null
      const active = repo.activeRuns()
      const { brief, shown } = today()
      const fresh = new Set([...shown.values()].filter(f => !f.read).map(f => f.productId))
      return {
        tracks: repo.listTracks().filter(t => t.status !== 'archived').map(t => ({
          track: t,
          products: repo.productsOfTrack(t.id).map(p => ({ product: p, hasNew: fresh.has(p.id), progress: progressOf(p.id, active) })),
          candidatesToReview: candidatesToReview(t),
          recommending: recommending(t.id),
        })),
        todayDate: rt.today(),
        todayUnread: brief ? unreadCount(brief, shown) : 0,
        todayCostYuan: repo.spentOn(rt.today()),
        runTime: rt.settings().runTime,
        browserAvailable: rt.browserAvailable(),
        researchBroken,
        dataDir: rt.dataDir,
      }
    },

    'GET brief': ({ query }) => {
      const date = query.date === undefined ? rt.today() : day(query.date, 'date')
      const brief = repo.getBrief(date)
      const prevDate = repo.previousBriefDate(date)
      if (!brief) return { brief: null, findings: [], products: [], sources: [], changed: {}, prevDate }
      const findings = [...brief.findingIds, ...brief.minorIds].flatMap(id => repo.getFinding(id) ?? []).filter(isShown)
      return {
        brief,
        findings,
        products: products([...findings.map(f => f.productId), ...brief.quietProductIds, ...brief.skipped.map(s => s.productId)]),
        sources: repo.getSources(findings.flatMap(f => f.sourceIds)),
        changed: changedBy(findings),
        prevDate,
      }
    },

    'POST findings/:id/read': ({ params }) => {
      if (!repo.getFinding(params.id!)) notFound('找不到这条发现')
      repo.updateFinding(params.id!, { read: true })
      return { ok: true }
    },

    'POST brief/read-all': async req => {
      const date = day(ReadAll.parse(await req.body()).date, 'date')
      const brief = repo.getBrief(date) ?? notFound('这一天没有哨报')
      for (const id of [...brief.findingIds, ...brief.minorIds]) if (repo.getFinding(id)) repo.updateFinding(id, { read: true })
      return { ok: true }
    },

    'POST tracks': async req => {
      const body = NewTrack.parse(await req.body())
      const created = repo.createTrack({ name: body.name, brief: body.brief, dimensions: trackDimensions(rt, body.extraDimensions), status: 'picking' })
      return { trackId: created.id, batchId: await startRecommendation(rt.jobs, created.id) }
    },

    'PATCH tracks/:id': async req => {
      const current = track(req.params.id!)
      const body = TrackPatch.parse(await req.body())
      // The track's own dimensions are among the keys in use, so a label it keeps keeps its key.
      const dimensions = body.extraDimensions && trackDimensions(rt, body.extraDimensions)
      const updated = repo.updateTrack(current.id, { name: body.name, brief: body.brief, dimensions })
      // The user asked for these: fill them in now (Ruling 25), not after the 7 days that pace automatic top-ups.
      const had = new Set(current.dimensions.map(d => d.key))
      const added = updated.dimensions.filter(d => !had.has(d.key)).map(d => d.key)
      if (added.length) {
        const lacking = repo.productsOfTrack(current.id).filter(p => isWorkedOn(p) && lacksCard(p.id, added)).map(p => p.id)
        if (lacking.length) rt.background(rt.scheduler.topUpNow(lacking), `top-up of the products of track ${current.id}`)
      }
      return updated
    },

    'POST tracks/:id/recommend': async req => {
      const t = track(req.params.id!)
      const { refine } = Recommend.parse(await req.body() ?? {})
      if (recommending(t.id)) throw new ApiError(409, '上一轮推荐还在进行，稍等它结束再调整')
      return { batchId: await startRecommendation(rt.jobs, t.id, refine) }
    },

    'GET tracks/:id/candidates': ({ params }) => {
      const t = track(params.id!)
      const run = repo.latestRun('recommend', { trackId: t.id })
      const batchId = run?.id ?? repo.latestBatchId(t.id)
      const started = run?.startedAt ? Date.parse(run.startedAt) : NaN
      const ended = run?.endedAt ? Date.parse(run.endedAt) : rt.clock.now().getTime()
      // The products of every other track that is still on (the scheduler skips an archived one), in the order they are listed.
      const elsewhere = repo.listTracks().filter(other => other.id !== t.id && other.status !== 'archived')
        .map(other => ({ name: other.name, products: new Set(repo.productsOfTrack(other.id).map(item => item.id)) }))
      return {
        batchId,
        running: run !== null && isActive(run),
        status: run?.status ?? null,
        error: run?.error ?? null,
        elapsedSec: Number.isNaN(started) ? 0 : Math.max(0, Math.floor((ended - started) / 1000)),
        candidates: batchId === null ? [] : repo.listCandidates(t.id, batchId).flatMap(c => {
          const p = repo.getProduct(c.productId)
          return p ? [{ ...c, product: p, ...trackedElsewhere(p, elsewhere) }] : []
        }),
      }
    },

    'POST tracks/:id/start': async req => {
      const t = track(req.params.id!)
      const { candidateIds } = Start.parse(await req.body())
      const ofTrack = new Map(repo.listCandidates(t.id).map(c => [c.id, c]))
      const chosen = [...new Set(candidateIds)].map(id => ofTrack.get(id) ?? badRequest(`候选 ${id} 不是这个赛道的`))
      const picked = new Set(chosen.map(c => c.id))
      for (const batch of new Set(chosen.map(c => c.batchId)))
        for (const c of repo.listCandidates(t.id, batch)) repo.setCandidateSelected(c.id, picked.has(c.id))
      repo.updateTrack(t.id, { status: 'active' })
      const latest = repo.latestBatchId(t.id)
      if (latest !== null && chosen.some(c => c.batchId === latest)) {
        const reviewed: Reviewed = { batchId: latest, candidateIds: repo.listCandidates(t.id, latest).map(c => c.id) }
        repo.setSetting(reviewedKey(t.id), reviewed)
      }
      // The products join as `joinTrack` says: a twin followed elsewhere instead of the candidate's own row, baselines for
      // the new ones, the missing cards at once for the followed ones.
      joinTrack(rt, t.id, chosen.map(c => c.productId))
      return { ok: true }
    },

    'POST tracks/:id/add-product': async req => {
      const t = track(req.params.id!)
      const { name, officialUrl } = AddProduct.parse(await req.body())
      if (t.status === 'archived') throw new ApiError(409, '这个赛道已归档')
      const followed = repo.findFollowedByName(name)
      if (followed.length === 1) {
        const p = followed[0]!
        if (repo.productsOfTrack(t.id).some(here => here.id === p.id)) return { linked: p.id, status: p.status as FollowedStatus, already: true as const }
        const [joined] = joinTrack(rt, t.id, [p.id])
        return { linked: joined!.productId, status: joined!.status as FollowedStatus }
      }
      // Not followed, or the name alone cannot say which (the same name at two companies): confirm it first, unless that
      // is already being done (a second click).
      const key = nameKey(name)
      const confirming = repo.activeRuns().find(r => r.kind === 'identify' && r.trackId === t.id && r.subject !== null && nameKey(r.subject) === key)
      if (confirming) return { runId: confirming.id }
      return { runId: await startIdentify({ ...rt.jobs, scheduler: rt.scheduler }, t.id, { name, officialUrl: officialUrl ?? null }) }
    },

    'POST products/:id/link': async req => {
      const p = product(req.params.id!)
      const { trackId } = TrackRef.parse(await req.body())
      const target = joinableTrack(p, trackId)
      return { toppedUp: toppedUp(joinTrack(rt, target.id, [p.id])[0]) }
    },

    'POST products/:id/unlink': async req => {
      const p = product(req.params.id!)
      const { trackId } = TrackRef.parse(await req.body())
      const tracks = tracksOf(p.id)
      if (!tracks.some(t => t.id === trackId)) throw new ApiError(409, '它不在这个赛道里')
      // A track that is archived keeps nothing running: leaving the product there alone is leaving it in none.
      if (!tracks.some(t => t.id !== trackId && t.status !== 'archived')) throw new ApiError(409, ONLY_TRACK)
      repo.unlinkProduct(trackId, p.id)
      return { ok: true }
    },

    'POST products/:id/move': async req => {
      const p = product(req.params.id!)
      const { from, to } = Move.parse(await req.body())
      const target = joinableTrack(p, to)
      if (!tracksOf(p.id).some(t => t.id === from)) throw new ApiError(409, '它不在这个赛道里')
      return { toppedUp: toppedUp(joinTrack(rt, target.id, [p.id], from)[0]) }
    },

    'GET products/:id': ({ params }) => {
      const p = product(params.id!)
      const cards = repo.latestCards(p.id)
      const dimensions = repo.dimensionsOfProduct(p.id)
      const keys = new Set([...dimensions.map(d => d.key), ...cards.map(c => c.dimension)])
      return {
        product: p,
        facts: repo.latestFacts(p.id),
        cards,
        history: Object.fromEntries([...keys].map(key =>
          [key, repo.cardHistory(p.id, key).map(v => ({ version: v.version, changeNote: v.changeNote, createdAt: v.createdAt }))])),
        sources: repo.getSources(cards.flatMap(c => c.sourceIds)),
        dimensions,
        progress: progressOf(p.id, repo.activeRuns(p.id)),
      }
    },

    'GET products/:id/findings': ({ params }) => {
      const p = product(params.id!)
      const findings = repo.findingsOfProduct(p.id).filter(f => f.status !== 'pending' && f.status !== 'withdrawn')
      return { findings, sources: repo.getSources(findings.flatMap(f => f.sourceIds)), changed: changedBy(findings) }
    },

    'PATCH products/:id': async req => {
      const p = product(req.params.id!)
      const body = ProductPatch.parse(await req.body())
      if (body.status !== undefined && body.status !== p.status) {
        if (p.status !== 'tracking' && p.status !== 'paused') throw new ApiError(409, '建档完成后才能暂停或恢复跟踪')
        repo.setProductStatus(p.id, body.status)
      }
      if (body.dailyBudgetYuan !== undefined) repo.setProductBudget(p.id, body.dailyBudgetYuan)
      return repo.getProduct(p.id)!
    },

    'POST products/:id/update-now': async ({ params }) => {
      const p = product(params.id!)
      if (p.status !== 'tracking' && p.status !== 'baselining') throw new ApiError(409, '这个产品没有在跟踪，先恢复跟踪再更新')
      return { runId: await updateNow(p) }
    },

    'GET icons/:productId': async ({ params }) => {
      const p = product(params.productId!)
      // Only `<icons>/<id>.<kept type>`, whatever the stored path says: nothing outside the icons folder is ever read.
      const name = p.iconPath === null ? null : basename(p.iconPath)
      const ext = name?.startsWith(`${p.id}.`) ? name.slice(p.id.length + 1) : null
      const type = ext !== null && Object.hasOwn(ICON_TYPES, ext) ? ICON_TYPES[ext]! : null
      if (type === null || !/^[\w-]+$/.test(p.id)) notFound('这个产品没有图标')
      let bytes: Buffer
      try { bytes = await readFile(join(rt.iconsDir, `${p.id}.${ext}`)) }
      catch { notFound('这个产品没有图标') }
      return new RawReply(bytes, { 'content-type': type, 'cache-control': 'max-age=86400' })
    },

    'POST followup': async req => {
      const { findingId } = Followup.parse(await req.body())
      if (!repo.getFinding(findingId)) notFound('找不到这条发现')
      return startFollowup({ repo, driver: rt.driver, clock: rt.clock, icons: rt.icons, settings: () => rt.settings() }, findingId)
    },

    'GET models': async () => ({ groups: await listModelGroups(rt.ctx.llm), defaultModel: rt.defaultModel() }),

    'GET runs': ({ query }) => {
      const days = query.days === undefined ? 7 : Number(query.days)
      if (!Number.isInteger(days) || days < 1 || days > MAX_RUN_DAYS) throw new ApiError(400, `days must be a whole number from 1 to ${MAX_RUN_DAYS}`)
      const names = new Map<Id, string>()
      const nameOf = (id: Id | null) => {
        if (id === null) return null
        if (!names.has(id)) names.set(id, repo.getProduct(id)?.name ?? '')
        return names.get(id) || null
      }
      return { runs: repo.listRuns(shiftDate(rt.today(), 1 - days)).map(r => ({ ...r, productName: nameOf(r.productId) })) }
    },

    'POST runs/:id/retry': async ({ params }) => {
      const run = repo.getRun(params.id!) ?? notFound('找不到这次运行')
      if (run.status !== 'failed') throw new ApiError(409, '只有失败的运行可以重试')
      if (redone(run)) throw new ApiError(409, '已经重新跑过了')
      switch (run.kind) {
        case 'recommend': {
          if (!run.trackId) throw new ApiError(409, '这次推荐不属于任何赛道，没法重试')
          const t = track(run.trackId)
          if (recommending(t.id)) throw new ApiError(409, '上一轮推荐还在进行，稍等它结束再调整')
          return { runId: await startRecommendation(rt.jobs, t.id) }
        }
        case 'baseline': case 'daily': case 'verify': {
          const p = product(run.productId ?? '')
          if (p.status !== 'tracking' && p.status !== 'baselining') throw new ApiError(409, '这个产品没有在跟踪，先恢复跟踪再更新')
          // A failed baseline is retried as one (for a tracked product too: the 7-day limit on top-ups is for the daily
          // runs, not for the user asking); a failed update as 「立即更新」, which re-baselines a product in 建档中; a failed
          // check of a tracked product, or an update that failed only because its check did not finish (「核查没有完成：」),
          // as that check alone, for its day (the research it would check is already in).
          if (run.kind === 'baseline') return { runId: await baselineNow(p) }
          const checkOnly = run.kind === 'verify' || run.error?.startsWith(CHECK_NOT_DONE) === true
          return { runId: await (checkOnly && p.status === 'tracking' ? checkNow(p, run.date) : updateNow(p)) }
        }
        case 'synthesize': {
          // The model is asked only when the day has something to sum up; with nothing, the brief is rewritten all the same.
          const yesterday = shiftDate(rt.today(), -1)
          const runId = await startedRun(r => r.kind === 'synthesize' && r.date === run.date,
            () => { rt.background(rt.scheduler.rewriteBrief(run.date), `brief of ${run.date}`) },
            run.date < yesterday ? run.date : yesterday) // its new run is dated with the brief, days ago perhaps
          return { runId: runId ?? run.id }
        }
        case 'followup':
          throw new ApiError(409, '追问不能重试，请从哨报里重新点「追问」')
        default:
          throw new ApiError(409, '这种运行不能重试')
      }
    },
  }

  const routes = Object.entries(table).map(([key, handler]) => {
    const [method, pattern] = key.split(' ') as [string, string]
    return { method, pattern, handler: handler as (req: ApiRequestParts) => unknown }
  })
  return async (route, req) => {
    const space = route.indexOf(' ')
    const method = route.slice(0, space)
    const path = route.slice(space + 1)
    for (const r of routes) {
      if (r.method !== method) continue
      const params = matchRoute(r.pattern, path)
      if (params) return r.handler({ ...req, params })
    }
    throw new ApiError(404, 'Unknown operation')
  }
}

function notFound(message: string): never { throw new ApiError(404, message) }
function badRequest(message: string): never { throw new ApiError(400, message) }
