/**
 * When the daily update runs, and what one day of it does (design §7.3, §7.5, §7.6, §7.9).
 *
 * Outpost keeps its own timer for the next local `runTime` (default 08:00). On start, a day whose run time has passed
 * without a finished run (the desktop app was closed at 08:00, say) is run at once, and the timer is set for the next
 * day; the same day is never run twice. A day picks up where it stopped: only the tracked products without a finished
 * daily run that day are run (a run interrupted by quitting does not count as finished, nor as failed). A product whose
 * run failed is tried once more that day; after two failures it is left and named in the brief.
 *
 * The brief is written when every product is through, or at the cutoff, two hours after the day began, whichever comes
 * first. Products that finish after the cutoff are added to it (「迟到」). The day counts as complete
 * (`lastCompletedDailyDate`) only once every product is through and the brief is written; then old sessions are archived.
 */
import { cutoffAt, localDate, nextRunAt, shouldCatchUp } from '../core/calendar.ts'
import type { Id, Product, Run } from '../core/types.ts'
import type { Repo } from '../store/repo.ts'
import { budgetRefusal, STOPPED_ERROR } from './jobs/runner.ts'
import type { Clock } from './ports.ts'

/** Settings key: the local date (`YYYY-MM-DD`) of the last day whose run finished. */
export const LAST_COMPLETED = 'lastCompletedDailyDate'
/** How many failed daily runs a product may have in one day before it is left for that day. */
export const MAX_DAILY_FAILURES = 2

const DEFAULT_RUN_TIME = '08:00'
const RUN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Read on each use: they can change while Outpost runs. */
export interface SchedulerSettings {
  /** `HH:MM`, local time. */
  runTime: string
  /** Products updated at the same time. */
  maxParallel: number
  dailyBudgetYuan: number
}

export interface SchedulerDeps {
  clock: Clock
  repo: Repo
  settings: () => SchedulerSettings
  /** The product's daily session and check, counted toward `date` (`runDailyProduct`). */
  runDailyProduct(productId: Id, date: string): Promise<Run>
  /** Writes the day's brief (`synthesizeBrief`). */
  synthesize(date: string): Promise<unknown>
  /** Adds a product that finished after the brief was written (`appendLate`). */
  appendLate(date: string, productId: Id): Promise<unknown>
  /** Archives the sessions of runs that ended long ago (`JobRunner.archiveOld`). */
  archiveOld(now: Date): Promise<void>
  /** Baselines the products again, asking only for what they lack; resolves once they are over (`baselineProducts`). */
  rebaseline(productIds: Id[]): Promise<void>
  /** Where failures of background work are reported; default `console.warn`. */
  log?: (message: string) => void
}

type Outcome = 'done' | 'skipped' | 'failed' | 'stopped'

export class Scheduler {
  private readonly deps: SchedulerDeps
  private readonly log: (message: string) => void
  private cancelTimer: (() => void) | null = null
  private stopped = false
  /** Days being run, so that a second request for the same day joins the first. */
  private readonly days = new Map<string, Promise<void>>()
  /** Daily runs in flight, by product: a product is updated by one run at a time (two checks of one product would race). */
  private readonly busy = new Map<Id, Promise<Run>>()
  private readonly cutoffs = new Set<() => void>()

  constructor(deps: SchedulerDeps) {
    this.deps = deps
    this.log = deps.log ?? (message => console.warn(`dsh-outpost: ${message}`))
  }

  /**
   * Runs today now if its run time has passed and it has not finished, and sets the timer for the next run time.
   * Calling it again is harmless: the timer is set anew, and a day already running is not started twice.
   */
  start(): void {
    this.stopped = false
    const now = this.deps.clock.now()
    const runTime = this.runTime()
    if (shouldCatchUp(now, runTime, this.lastCompleted())) this.launch(localDate(now))
    this.arm(nextRunAt(now, runTime))
  }

  /** Cancels the timers. Products already running go on; nothing new starts, and the day is left for the next start. */
  stop(): void {
    this.stopped = true
    this.cancelTimer?.()
    this.cancelTimer = null
    for (const cancel of this.cutoffs) cancel()
    this.cutoffs.clear()
  }

  /**
   * Runs one day (`YYYY-MM-DD`) as the module describes and resolves when it is over: every product through and the
   * brief written, or Outpost stopping. It does not reject; failures are logged. A day already running is joined.
   */
  runDay(date: string): Promise<void> {
    const running = this.days.get(date)
    if (running) return running
    const work = this.day(date).catch(error => { this.log(`daily run of ${date} failed: ${messageOf(error)}`) }).finally(() => { this.days.delete(date) })
    this.days.set(date, work)
    return work
  }

  /**
   * 「立即更新」: updates the product now, for today, then adds it to today's brief (`appendLate`), or writes the brief
   * if today has none yet. A product stuck in 建档中 is baselined again instead (resolves with null); a tracked one
   * missing a dimension's card gets it first. When the product's run is already in flight, that run is awaited instead
   * of starting a second one, and whoever started it takes care of the brief.
   * @throws When the product does not exist.
   */
  async runProductNow(productId: Id): Promise<Run | null> {
    const { repo, clock } = this.deps
    const product = repo.getProduct(productId)
    if (!product) throw new Error(`Unknown product ${productId}`)
    if (product.status === 'baselining') {
      await this.deps.rebaseline([productId])
      return null
    }
    const date = localDate(clock.now())
    if (!this.busy.has(productId) && this.lacksCards(productId)) await this.deps.rebaseline([productId])
    const inFlight = this.busy.get(productId)
    if (inFlight) return inFlight
    const run = await this.daily(productId, date)
    try {
      if (repo.getBrief(date)) await this.deps.appendLate(date, productId)
      else await this.deps.synthesize(date)
    } catch (error) {
      this.log(`brief of ${date} after updating product ${productId} failed: ${messageOf(error)}`)
    }
    return run
  }

  // ---- the day ----

  private async day(date: string): Promise<void> {
    const { clock } = this.deps
    const start = clock.now()
    const { toRun, topUp, stuck } = this.plan(date)
    if (stuck.length) void this.deps.rebaseline(stuck).catch(error => { this.log(`re-baseline failed: ${messageOf(error)}`) })

    // Writes to the brief, one after another (a late product must not recompose it while the cutoff's is being written).
    let written = Promise.resolve(true)
    const toBrief = (label: string, write: () => Promise<unknown>) => {
      written = written.then(async ok => {
        if (this.stopped) return false
        try { await write(); return ok } catch (error) { this.log(`${label} of ${date} failed: ${messageOf(error)}`); return false }
      })
    }

    let over = false
    let pastCutoff = false
    const cancelCutoff = clock.at(cutoffAt(start), () => {
      this.cutoffs.delete(cancelCutoff)
      if (over || this.stopped) return
      pastCutoff = true
      toBrief('brief', () => this.deps.synthesize(date))
    })
    this.cutoffs.add(cancelCutoff)

    let interrupted = false
    await this.pool(toRun, () => !interrupted && !this.stopped, async productId => {
      const outcome = await this.product(date, productId, topUp.has(productId))
      if (outcome === 'stopped') interrupted = true
      else if (pastCutoff) toBrief(`late product ${productId} in the brief`, () => this.deps.appendLate(date, productId))
    })
    over = true
    cancelCutoff()
    this.cutoffs.delete(cancelCutoff)
    if (interrupted || this.stopped) { // the rest of the day waits for the next start
      await written
      return
    }

    if (!pastCutoff) toBrief('brief', () => this.deps.synthesize(date))
    if (await written) this.complete(date)
    try { await this.deps.archiveOld(clock.now()) } catch (error) { this.log(`archiving old sessions failed: ${messageOf(error)}`) }
  }

  /** The day's work: the tracked products to run (in tracking order), those of them missing a card, and those stuck in 建档中. */
  private plan(date: string): { toRun: Id[]; topUp: Set<Id>; stuck: Id[] } {
    const { repo } = this.deps
    const products = new Map<Id, Product>()
    for (const track of repo.listTracks()) {
      if (track.status === 'archived') continue
      for (const product of repo.productsOfTrack(track.id)) if (!products.has(product.id)) products.set(product.id, product)
    }
    const all = [...products.values()]
    const toRun = all.filter(p => p.status === 'tracking').map(p => p.id).filter(id => {
      const { finished, failures } = this.standing(date, id)
      return !finished && failures < MAX_DAILY_FAILURES
    })
    return { toRun, topUp: new Set(toRun.filter(id => this.lacksCards(id))), stuck: all.filter(p => p.status === 'baselining').map(p => p.id) }
  }

  /** One product's day: its missing cards first, then its daily run, tried once more if it failed. */
  private async product(date: string, productId: Id, topUp: boolean): Promise<Outcome> {
    const { repo, settings, clock } = this.deps
    if (topUp) await this.deps.rebaseline([productId]).catch(error => { this.log(`baseline of product ${productId} failed: ${messageOf(error)}`) })
    let failures = this.standing(date, productId).failures
    for (;;) {
      if (this.stopped) return 'stopped'
      const other = this.busy.get(productId)
      if (other) { // 「立即更新」 is running it: see where the day stands once that is over
        await other.catch(() => {})
        const now = this.standing(date, productId)
        if (now.finished) return 'done'
        if ((failures = now.failures) >= MAX_DAILY_FAILURES) return 'failed'
        continue
      }
      const refused = budgetRefusal(repo, settings().dailyBudgetYuan, date, productId)
      if (refused) { // not started at all: a skipped run says why, for the brief
        const run = repo.createRun({ kind: 'daily', date, trackId: null, productId })
        repo.updateRun(run.id, { status: 'skipped', error: refused, endedAt: clock.now().toISOString() })
        return 'skipped'
      }
      let run: Run
      try {
        run = await this.daily(productId, date)
      } catch (error) {
        this.log(`daily run of product ${productId} failed: ${messageOf(error)}`)
        return 'failed'
      }
      if (run.status === 'failed' && run.error === STOPPED_ERROR) return 'stopped'
      if (run.status !== 'failed') return run.status === 'skipped' ? 'skipped' : 'done'
      if (++failures >= MAX_DAILY_FAILURES) return 'failed'
    }
  }

  /** Whether the product's day is finished (a daily run done or skipped), and how many of its runs failed (stops aside). */
  private standing(date: string, productId: Id): { finished: boolean; failures: number } {
    const runs = this.deps.repo.runsOfDate(date, 'daily').filter(r => r.productId === productId)
    return {
      finished: runs.some(r => r.status === 'done' || r.status === 'skipped'),
      failures: runs.filter(r => r.status === 'failed' && r.error !== STOPPED_ERROR).length,
    }
  }

  /** Whether a dimension of the product has no card in its dossier. */
  private lacksCards(productId: Id): boolean {
    const { repo } = this.deps
    const have = new Set(repo.latestCards(productId).map(c => c.dimension))
    return repo.dimensionsOfProduct(productId).some(d => !have.has(d.key))
  }

  /** The product's daily run; the product is busy until it ends. */
  private daily(productId: Id, date: string): Promise<Run> {
    const work: Promise<Run> = this.deps.runDailyProduct(productId, date).finally(() => {
      if (this.busy.get(productId) === work) this.busy.delete(productId)
    })
    this.busy.set(productId, work)
    return work
  }

  /** Runs `work` on each id, at most `maxParallel` at a time, in order; no new one starts once `go` says no. */
  private async pool(ids: Id[], go: () => boolean, work: (id: Id) => Promise<void>): Promise<void> {
    const queue = [...ids]
    const limit = Math.max(1, Math.floor(this.deps.settings().maxParallel) || 1)
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined && go(); id = queue.shift()) await work(id)
    }
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, worker))
  }

  /** Records the day as complete; an older day finishing late does not move it back. */
  private complete(date: string): void {
    const last = this.lastCompleted()
    if (last === null || date > last) this.deps.repo.setSetting(LAST_COMPLETED, date)
  }

  // ---- the timer ----

  private launch(date: string): void {
    void this.runDay(date)
  }

  private arm(when: Date): void {
    this.cancelTimer?.()
    this.cancelTimer = this.deps.clock.at(when, () => this.fire(when))
  }

  /**
   * The timer set for `target` went off. Timers can fire a moment early, so the time it stands for is `target` (or
   * now, if later): an early 07:59:59.999 still runs the 08:00 day, once, and the next timer is set for tomorrow.
   */
  private fire(target: Date): void {
    this.cancelTimer = null
    if (this.stopped) return
    const now = this.deps.clock.now()
    const at = now.getTime() < target.getTime() ? target : now
    const runTime = this.runTime()
    if (shouldCatchUp(at, runTime, this.lastCompleted())) this.launch(localDate(at))
    this.arm(nextRunAt(at, runTime))
  }

  private lastCompleted(): string | null {
    const value = this.deps.repo.getSetting<unknown>(LAST_COMPLETED)
    return typeof value === 'string' ? value : null
  }

  /** The configured run time, or 08:00 if it is not a valid `HH:MM` (the calendar throws on those). */
  private runTime(): string {
    const value = this.deps.settings().runTime
    if (typeof value === 'string' && RUN_TIME.test(value)) return value
    this.log(`runTime "${String(value)}" is not HH:MM; using ${DEFAULT_RUN_TIME}`)
    return DEFAULT_RUN_TIME
  }
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)
