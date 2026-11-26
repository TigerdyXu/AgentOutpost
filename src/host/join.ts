/**
 * Putting products in a track: what 开始跟踪 does with the candidates picked (`POST tracks/:id/start`), what a product
 * confirmed by name does once it passes (`identify`), and what a product already followed does when it is added to
 * another track by name.
 */
import { identityKey } from '../core/identity.ts'
import type { DimensionKey, Id, Product, ProductStatus } from '../core/types.ts'
import type { Repo } from '../store/repo.ts'
import type { Scheduler } from './scheduler.ts'

export interface JoinDeps {
  repo: Repo
  scheduler: Pick<Scheduler, 'baseline' | 'topUpNow'>
  /** Lets work go on after the caller returns (`Runtime.background`, `JobRunner.track`). */
  background(work: Promise<unknown>, label: string): void
}

/** One product that joined the track. */
export interface Joined {
  /** The row that joined: the one asked for, or the followed product it is another spelling of. */
  productId: Id
  /** Its status as it joined (a fresh one becomes 建档中 once its baseline starts). */
  status: ProductStatus
  /**
   * What it gets: `baseline`, new to Outpost (建档); `top-up`, followed and worked on, the cards of `missing` at once;
   * null, nothing (it was in the track already, lacks no card, or is paused).
   */
  work: 'baseline' | 'top-up' | null
  /**
   * The track's dimensions that none of the product's other tracks has and that it has no card for: what this track adds
   * to it. Empty for a product that was in the track already.
   */
  missing: DimensionKey[]
}

/** A row Outpost does not follow: it is baselined when it joins, unless it is another spelling of one it follows. */
const isNew = (p: Product) => p.status === 'candidate' || p.status === 'archived'
/** Tracked, or in 建档中: what gets the dimensions a new track adds at once. */
const isWorkedOn = (p: Product) => p.status === 'tracking' || p.status === 'baselining'

/**
 * Links the products to the track, in the order given, and gets each the work it needs (M1.1 §13):
 *
 * - A row that Outpost does not follow (a candidate, an archived one) that is another spelling of a product it follows
 *   (`findSameProduct`: tracking, paused or in 建档中) is that product: the followed row joins instead, and the row asked
 *   for is left as it is, so one product is never baselined or run twice. Two rows asked for that are spellings of one
 *   product are one too: the first is taken, the later one is left out.
 * - A product new to Outpost is baselined (`Scheduler.baseline`; 建档中 at once).
 * - A product already followed only joins: the scheduler fills in the dimensions this track adds before its next daily
 *   run, since a baseline beside that run would put two checks on one product. When tracked (or in 建档中) and missing a
 *   card for a dimension this track adds, it gets those cards at once (`Scheduler.topUpNow`, which waits for its daily run
 *   or its baseline if one is in flight). A paused one is linked as it is: neither resumed nor topped up.
 *
 * The baselines and top-ups go on in the background, once all the products have joined (and, for a move, left).
 *
 * With `leaving`, each product that joined is taken out of that track in the same step (a move): the joining comes first
 * and both are one transaction, so a failure leaves the product where it was, and it is never in no track. What a product
 * lacks is told as it joins, while it is still in the track it leaves. Its top-up starts after it has left, so it asks for
 * what the tracks it is in now need.
 *
 * @param leaving - The track the products move out of; none: they are only added.
 * @returns One entry per product that joined (spellings left out are not), in the order given; unknown ids are skipped.
 * @throws When the track does not exist (nothing is linked then).
 */
export function joinTrack(deps: JoinDeps, trackId: Id, productIds: Id[], leaving?: Id): Joined[] {
  const { repo, scheduler } = deps
  const track = repo.listTracks().find(t => t.id === trackId)
  if (!track) throw new Error(`Unknown track ${trackId}`)
  const keys = track.dimensions.map(d => d.key)
  const linked = new Set(repo.productsOfTrack(trackId).map(p => p.id))
  const taken = new Set<string>()
  const joined: Joined[] = []
  repo.atomic(() => {
    for (const id of productIds) {
      const named = repo.getProduct(id)
      if (!named) continue
      const p = isNew(named) ? repo.findSameProduct(named) ?? named : named
      const same = identityKey(p.name, p.company)
      if (taken.has(same)) continue
      taken.add(same)
      const had = new Set(repo.dimensionsOfProduct(p.id).map(d => d.key))
      const carded = new Set(repo.latestCards(p.id).map(c => c.dimension))
      const missing = linked.has(p.id) ? [] : keys.filter(key => !had.has(key) && !carded.has(key))
      repo.linkProduct(trackId, p.id)
      if (leaving !== undefined) repo.unlinkProduct(leaving, p.id)
      const work = isNew(p) ? 'baseline' : isWorkedOn(p) && missing.length ? 'top-up' : null
      joined.push({ productId: p.id, status: p.status, work, missing })
    }
  })
  const of = (work: Joined['work']) => joined.filter(j => j.work === work).map(j => j.productId)
  deps.background(scheduler.baseline(of('baseline')), `baseline of the products of track ${trackId}`)
  const lacking = of('top-up')
  if (lacking.length) deps.background(scheduler.topUpNow(lacking), `top-up of the products joining track ${trackId}`)
  return joined
}
