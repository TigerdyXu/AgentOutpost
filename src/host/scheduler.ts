/**
 * When the daily update runs, and what one day of it does (design §7.3, §7.5, §7.6, §7.9).
 *
 * Outpost keeps its own timer for the next local `runTime` (default 08:00). On start, a day whose run time has passed
 * without a finished run (the desktop app was closed at 08:00, say) is run at once, and the timer is set for the next
 * day; the same day is never run twice. The run time is volatile: once a minute (the clock's `tick`) the configured one is
 * compared with the one the timer was set with, and a change sets the timer again (`checkRunTime`). A day picks up where
 * it stopped: only the tracked products without a finished daily run that day are run (a run interrupted by quitting does
 * not count as finished, nor as failed). A product whose run failed is tried once more that day (unless it was paused
 * meanwhile); after two failures it is left and named in the brief.
 *
 * A tracked product missing a dimension's card gets it first, at most once in `TOP_UP_EVERY_DAYS` days; products stuck in
 * 建档中 are baselined again once every run day. A product is worked on by one thing at a time: its top-up (or a baseline
 * asked for through `baseline`), its daily run, or a check retried on its own (`recheck`), whether the day, 「立即更新」 or
 * 重试 started them (two checks of one product side by side would race). A product 「立即更新」 finished while it waited in
 * the day's line is not run again by the day.
 *
 * The brief is written when every product is through, or at the cutoff, two hours after the day began, whichever comes
 * first. Products that finish after the cutoff are added to it (「迟到」). The day counts as complete
 * (`lastCompletedDailyDate`) only once every product is through and the brief is written; then old sessions are archived.
 * A day with no tracked product to look at (nothing tracked yet, and no daily run that day) writes no brief and is not
 * complete, so products tracked later that day still run when the run time comes again (it is moved, or the app restarts).
 * Every write of a day's brief, the day's own, 「立即更新」's and 重试's, goes through one queue per date.
 *
 * A day interrupted before its brief was written (the app quit mid-run) gets its brief, from what it has, on the next
 * start; its unfinished products are not researched for that day any more.
 */
import { cutoffAt, localDate, nextRunAt, shouldCatchUp, tomorrowRunAt } from '../core/calendar.ts'
import { modelFor, type Billing, type ModelRef, type ModelSettings } from '../core/models.ts'
import type { Id, Product, Run } from '../core/types.ts'
import type { Repo } from '../store/repo.ts'
import { CHECK_NOT_DONE } from './jobs/daily.ts'
import { budgetRefusal, STOPPED_ERROR } from './jobs/runner.ts'
import type { Clock } from './ports.ts'

/** Settings key: the local date (`YYYY-MM-DD`) of the last day whose run finished. */
export const LAST_COMPLETED = 'lastCompletedDailyDate'
/** How many failed daily runs a product may have in one day before it is left for that day. */
export const MAX_DAILY_FAILURES = 2
/**
 * A tracked product missing a dimension's card is baselined again for it at most once in this many days: a card the
 * check keeps rejecting would otherwise cost a baseline session every day. Products still in 建档中 are retried daily.
 */
export const TOP_UP_EVERY_DAYS = 7
/** How far back `start` looks for a day that has daily runs but no brief. */
export const MISSED_BRIEF_LOOKBACK_DAYS = 7

const DEFAULT_RUN_TIME = '08:00'
const RUN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/** Read on each use: they can change while Outpost runs. */
export interface SchedulerSettings extends ModelSettings {
  /** `HH:MM`, local time. */
  runTime: string
  /** Products updated at the same time. */
  maxParallel: number
  dailyBudgetYuan: number
  /** How work on a model is paid (`RuntimeSettings.billingFor`): research on a model that is not metered is not held to the budget. */
  billingFor(model: ModelRef | null): Billing
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
  /**
   * The product's check alone, counted toward `date` (`verifyProduct`, daily scope); rejects when it did not run to its
   * end (`VerifyNotRun`).
   */
  verifyProduct(productId: Id, date: string): Promise<void>
  /** After the day's brief, draws again the maps of the tracks whose dossiers changed (M2.1); none when absent. */
  drawMaps?(date: string): Promise<void>
  /** After the maps, starts the weekly suggestions of the tracks due for them (M2.2); none when absent. */
  suggestWeekly?(date: string): Promise<void>
  /** After the weekly suggestions, the rounds of the 专题 due (M2.3); none when absent. */
  updateTopics?(date: string): Promise<void>
  /** Last, the paragraphs of last week's recaps due (M3.4); none when absent. */
  writeRecaps?(date: string): Promise<void>
  /** Where failures of background work are reported; default `console.warn`. */
  log?: (message: string) => void
}

type Outcome = 'done' | 'skipped' | 'failed' | 'stopped'

export class Scheduler {
  private readonly deps: SchedulerDeps
  private readonly log: (message: string) => void
  private cancelTimer: (() => void) | null = null
  /** The run time the daily timer was set with: a change of the configured one is noticed against it. */
  private armedRunTime: string | null = null
  /** Looks about once a minute whether the configured run time still is `armedRunTime`. */
  private cancelWatch: (() => void) | null = null
  private stopped = false
  /** Days being run, so that a second request for the same day joins the first. */
  private readonly days = new Map<string, Promise<void>>()
  /** Daily runs in flight, by product: a product is updated by one run at a time (two checks of one product would race). */
  private readonly busy = new Map<Id, Promise<Run>>()
  /** Top-up baselines in flight, by product (the session and its check): whoever needs one joins the running one. */
  private readonly topUps = new Map<Id, Promise<void>>()
  /** Checks retried on their own (`recheck`) in flight, by product. */
  private readonly checks = new Map<Id, Promise<void>>()
  /** The last write queued for each date's brief: writes of one brief run one after another. */
  private readonly briefs = new Map<string, Promise<boolean>>()
  private readonly cutoffs = new Set<() => void>()

  constructor(deps: SchedulerDeps) {
    this.deps = deps
    this.log = deps.log ?? (message => console.warn(`dsh-outpost: ${message}`))
  }

  /**
   * Writes the brief of the latest earlier day that has daily runs but no brief (an interrupted day), then runs today now
   * if its run time has passed and it has not finished, and sets the timer for the next run time. Calling it again is
   * harmless: the timer is set anew, and neither a day already running nor a brief already written is done twice.
   */
  start(): void {
    this.stopped = false
    const now = this.deps.clock.now()
    const today = localDate(now)
    const missed = this.missedBriefDay(today)
    if (missed) void this.queueBrief(missed, 'brief of an interrupted day', () => this.deps.synthesize(missed))
    const runTime = this.runTime()
    if (shouldCatchUp(now, runTime, this.lastCompleted())) this.launch(today)
    this.arm(nextRunAt(now, runTime), runTime)
    this.cancelWatch?.()
    this.cancelWatch = this.deps.clock.tick(() => { this.checkRunTime() })
  }

  /** Cancels the timers. Products already running go on; nothing new starts, and the day is left for the next start. */
  stop(): void {
    this.stopped = true
    this.cancelTimer?.()
    this.cancelTimer = null
    this.cancelWatch?.()
    this.cancelWatch = null
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
   * if today has none yet (decided when the write's turn in the date's queue comes). A product stuck in 建档中 is
   * baselined again instead (resolves with null); a tracked one missing a dimension's card gets it first, within the same
   * 7-day limit as the daily run, joining a top-up already running. When the product's daily run is already in flight,
   * that run is awaited instead of starting a second one, and whoever started it takes care of the brief.
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
    for (;;) {
      const checking = this.checks.get(productId) // a check retried on its own: the update starts once it is over
      if (checking) { await checking; continue }
      const running = this.busy.get(productId)
      if (running) return running
      await this.topUp(productId, date)
      if (!this.checks.has(productId) && !this.busy.has(productId)) break // else the day, or 重试, started it meanwhile
    }
    const run = await this.daily(productId, date)
    await this.queueBrief(date, `brief after updating product ${productId}`,
      () => repo.getBrief(date) ? this.deps.appendLate(date, productId) : this.deps.synthesize(date))
    return run
  }

  /**
   * Baselines the products (建档 of products just added to a track, or a retry of a failed one) through the same entry as
   * the day's top-ups, each product on its own: a daily run of one of them, the day's or 「立即更新」's, waits for its
   * baseline instead of running a second check beside it, a baseline asked for while its daily run is in flight starts
   * once that run is over, and a top-up asked for meanwhile joins it. A product whose baseline is already running is
   * joined. Resolves once each is over; never rejects (failures are logged).
   */
  baseline(productIds: Id[]): Promise<void> {
    return Promise.all([...new Set(productIds)].map(id => this.topUps.get(id) ?? this.startBaseline(id, this.inFlight(id)))).then(() => {})
  }

  /**
   * Fills in the missing cards of tracked products now, because the user gave them dimensions they lack (a dimension
   * added to their track, or a track they joined). It is the day's top-up without the `TOP_UP_EVERY_DAYS` window, which
   * throttles automatic retries, not what the user asks for; the window itself is left as it was, so the next day's
   * automatic top-up still counts this one. Like any top-up it never runs beside the product's daily run (it starts once
   * that is over) and never beside another baseline of it: one in flight, asked for before the new dimension, is waited
   * for, and what it did not fill in is asked for after it. A product in 建档中 has its baseline joined (`rebaseline`
   * joins the one running, wherever it was started, or starts one) and is topped up after it the same way, once tracked.
   * A product neither tracked nor in 建档中, or missing no card, is left alone. Resolves once each is over; never rejects.
   */
  topUpNow(productIds: Id[]): Promise<void> {
    return Promise.all([...new Set(productIds)].map(id => this.forcedTopUp(id))).then(() => {})
  }

  /**
   * 重试 of a failed check: checks the product again for `date` (`verifyProduct`), without a daily session. It never runs
   * beside the product's daily run, baseline or another check: it waits for the daily run and the baseline in flight when
   * it is asked for, and whatever starts on the product after that waits for it (so neither ever waits for the other);
   * a recheck of the product already running is joined. When the check runs to its end, the product's daily run of `date`
   * that failed only because its check did not finish (「核查没有完成：…」) counts as done, its work being complete now
   * (unless one that day is done already), and the brief of `date` takes what was verified, as after 「立即更新」.
   * Resolves once it is over; never rejects (a check that did not finish is logged, and everything stays as it was). Once
   * stopped, nothing starts.
   * @throws When the product does not exist.
   */
  recheck(productId: Id, date: string): Promise<void> {
    const { repo } = this.deps
    if (!repo.getProduct(productId)) throw new Error(`Unknown product ${productId}`)
    const running = this.checks.get(productId)
    if (running) return running
    const before = [this.busy.get(productId), this.topUps.get(productId)]
    const work: Promise<void> = (async () => {
      await Promise.allSettled(before)
      if (this.stopped) return
      try {
        await this.deps.verifyProduct(productId, date)
      } catch (error) {
        this.log(`check of product ${productId} failed: ${messageOf(error)}`)
        return
      }
      const runs = repo.runsOfDate(date, 'daily').filter(r => r.productId === productId)
      const lacking = runs.filter(r => r.status === 'failed' && r.error?.startsWith(CHECK_NOT_DONE)).at(-1)
      if (lacking && !runs.some(r => r.status === 'done')) repo.updateRun(lacking.id, { status: 'done', error: null })
      await this.queueBrief(date, `brief after checking product ${productId}`,
        () => repo.getBrief(date) ? this.deps.appendLate(date, productId) : this.deps.synthesize(date))
    })().finally(() => { if (this.checks.get(productId) === work) this.checks.delete(productId) })
    this.checks.set(productId, work)
    return work
  }

  /**
   * Writes the brief of `date` again (a summary whose model call failed, retried), queued behind the writes of that brief
   * already waiting. Resolves with whether it went through; once the scheduler stopped, nothing is written.
   */
  rewriteBrief(date: string): Promise<boolean> {
    return this.queueBrief(date, 'rewritten brief', () => this.deps.synthesize(date))
  }

  /**
   * Whether work on the product is in flight here: its daily run, a baseline or top-up, or a check retried on its own,
   * including one waiting for another of these to end before it starts (what deleting the product must wait for).
   */
  isBusy(productId: Id): boolean {
    return this.busy.has(productId) || this.topUps.has(productId) || this.checks.has(productId)
  }

  /**
   * Resolves once every day, daily run, baseline and brief write in flight has ended, including those they start
   * meanwhile. After `stop` (and the runner's stop) they end soon; whoever closes the store waits for this first.
   */
  async idle(): Promise<void> {
    for (;;) {
      const work = [...this.days.values(), ...this.busy.values(), ...this.topUps.values(), ...this.checks.values(), ...this.briefs.values()]
      if (!work.length) return
      await Promise.allSettled(work)
    }
  }

  // ---- the day ----

  private async day(date: string): Promise<void> {
    const { clock } = this.deps
    const start = clock.now()
    const { toRun, stuck } = this.plan(date)
    if (stuck.length) void this.deps.rebaseline(stuck).catch(error => { this.log(`re-baseline failed: ${messageOf(error)}`) })
    // Nothing tracked to look at (a new install, say): no brief, and the day is not complete, so products tracked later
    // that day are still run when the run time comes again.
    if (!toRun.length && !this.deps.repo.runsOfDate(date, 'daily').length) return

    const writes: Promise<boolean>[] = []
    const toBrief = (label: string, write: () => Promise<unknown>) => { writes.push(this.queueBrief(date, label, write)) }

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
      const outcome = await this.product(date, productId)
      if (outcome === 'stopped') interrupted = true
      else if (pastCutoff) toBrief(`late product ${productId} in the brief`, () => this.deps.appendLate(date, productId))
    })
    over = true
    cancelCutoff()
    this.cutoffs.delete(cancelCutoff)
    if (interrupted || this.stopped) { // the rest of the day waits for the next start
      await Promise.all(writes)
      return
    }

    if (!pastCutoff) toBrief('brief', () => this.deps.synthesize(date))
    const written = (await Promise.all(writes)).every(Boolean)
    // Stopped while the brief was written: its gist may be the stand-in of a cut-off summary, so the day stays open and
    // the next start writes the brief again.
    if (this.stopped) return
    if (written) {
      this.complete(date)
      // The maps read the dossiers as the day left them; a map that cannot be drawn leaves the day complete.
      try { await this.deps.drawMaps?.(date) } catch (error) { this.log(`drawing the maps failed: ${messageOf(error)}`) }
      try { await this.deps.suggestWeekly?.(date) } catch (error) { this.log(`the weekly suggestions failed: ${messageOf(error)}`) }
      try { await this.deps.updateTopics?.(date) } catch (error) { this.log(`updating the topics failed: ${messageOf(error)}`) }
      try { await this.deps.writeRecaps?.(date) } catch (error) { this.log(`writing the weekly recaps failed: ${messageOf(error)}`) }
    }
    try { await this.deps.archiveOld(clock.now()) } catch (error) { this.log(`archiving old sessions failed: ${messageOf(error)}`) }
  }

  /**
   * The day's work: the tracked products to run (in tracking order), and those stuck in 建档中 without a baseline that
   * started that day and was not cut short by a stop (a day run again, after a restart, does not baseline them again).
   */
  private plan(date: string): { toRun: Id[]; stuck: Id[] } {
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
    const triedToday = new Set(repo.runsOfDate(date, 'baseline').filter(r => r.startedAt !== null && r.error !== STOPPED_ERROR).map(r => r.productId))
    return { toRun, stuck: all.filter(p => p.status === 'baselining' && !triedToday.has(p.id)).map(p => p.id) }
  }

  /**
   * One product's day: its missing cards first, then its daily run, tried once more if it failed. Whether it needs a
   * top-up is decided when its turn comes (「立即更新」 may have done it meanwhile), and never while its daily run is busy.
   */
  private async product(date: string, productId: Id): Promise<Outcome> {
    const { repo, settings, clock } = this.deps
    let failures = this.standing(date, productId).failures
    let toppedUp = false
    for (;;) {
      if (this.stopped) return 'stopped'
      // 「立即更新」 (or a check retried on its own) may have finished it while it waited in line, or just now.
      if (this.standing(date, productId).finished) return 'done'
      // Paused (or no longer tracked) since the day began: what ran stands, nothing more is started for it.
      if (repo.getProduct(productId)?.status !== 'tracking') return failures > 0 ? 'failed' : 'skipped'
      const other = this.inFlight(productId)
      if (other) { // 「立即更新」 or 重试 is working on it: see where the day stands once that is over
        await other.catch(() => {})
        if ((failures = this.standing(date, productId).failures) >= MAX_DAILY_FAILURES) return 'failed'
        continue
      }
      if (!toppedUp) { // look again afterwards: 「立即更新」 may have started the product while this waited
        toppedUp = true
        await this.topUp(productId, date)
        continue
      }
      const now = settings()
      const refused = budgetRefusal(repo, now, modelFor('research', now), date, productId) // none on a local or subscription model
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

  /** The product's daily run in flight, or its check retried on its own (`recheck`): what its other work waits for. */
  private inFlight(productId: Id): Promise<unknown> | undefined {
    return this.busy.get(productId) ?? this.checks.get(productId)
  }

  /** Whether the product's day is finished (a daily run done or skipped), and how many of its runs failed (stops aside). */
  private standing(date: string, productId: Id): { finished: boolean; failures: number } {
    const runs = this.deps.repo.runsOfDate(date, 'daily').filter(r => r.productId === productId)
    return {
      finished: runs.some(r => r.status === 'done' || r.status === 'skipped'),
      failures: runs.filter(r => r.status === 'failed' && r.error !== STOPPED_ERROR).length,
    }
  }

  /**
   * Fills in the product's missing cards before its run for `date` if it needs that (`needsTopUp`), or joins the top-up
   * already running for it. Resolves once it is over (at once when there is nothing to do); never rejects.
   */
  private topUp(productId: Id, date: string): Promise<void> {
    const running = this.topUps.get(productId)
    if (running) return running
    if (!this.needsTopUp(productId, date)) return Promise.resolve()
    return this.startBaseline(productId)
  }

  /** `topUpNow` of one product. */
  private forcedTopUp(productId: Id): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const due = () => !this.stopped && this.deps.repo.getProduct(productId)?.status === 'tracking' && this.missesCard(productId)
    // After a baseline it waited for: one started meanwhile (by the day, say) was asked for the dimensions as they are
    // now, so it joins that one; otherwise it asks for what is still missing.
    const then = () => this.topUps.get(productId) ?? (due() ? this.startBaseline(productId, this.inFlight(productId)) : undefined)
    const running = this.topUps.get(productId)
    if (running) return running.then(then)
    if (this.deps.repo.getProduct(productId)?.status === 'baselining') {
      // Its baseline may have been started outside the top-ups (the day's stuck products, 「立即更新」): join it there.
      return this.deps.rebaseline([productId])
        .catch(error => { this.log(`baseline of product ${productId} failed: ${messageOf(error)}`) })
        .then(then)
    }
    return due() ? this.startBaseline(productId, this.inFlight(productId)) : Promise.resolve()
  }

  /**
   * Starts the product's baseline (`rebaseline`), after `after` (its daily run in flight) if given, as its top-up in
   * flight; resolves once it is over, never rejects. One that was waiting when the scheduler stopped does not start.
   */
  private startBaseline(productId: Id, after?: Promise<unknown>): Promise<void> {
    const rebaseline = () => this.deps.rebaseline([productId])
    const later = () => this.stopped ? undefined : rebaseline()
    const work: Promise<void> = (after ? after.then(later, later) : rebaseline())
      .catch(error => { this.log(`baseline of product ${productId} failed: ${messageOf(error)}`) })
      .finally(() => { if (this.topUps.get(productId) === work) this.topUps.delete(productId) })
    this.topUps.set(productId, work)
    return work
  }

  /**
   * Whether a tracked product should be baselined for its missing cards before its run for `date`: a dimension of it has
   * no card, and no baseline of it finished in the `TOP_UP_EVERY_DAYS` days ending with `date` (read from the runs table).
   * Only a baseline that started and ended counts: one the budget skipped never started, one cut short by a stop or left
   * behind by a crash was interrupted, and one still running is joined (`topUp`), not counted.
   */
  private needsTopUp(productId: Id, date: string): boolean {
    const { repo } = this.deps
    if (!this.missesCard(productId)) return false
    const since = shiftDate(date, 1 - TOP_UP_EVERY_DAYS)
    return !repo.listRuns(since).some(r => r.kind === 'baseline' && r.productId === productId && r.date <= date
      && r.startedAt !== null && r.endedAt !== null && r.error !== STOPPED_ERROR)
  }

  /** Whether a dimension of the product (of any of its tracks) has no card yet. */
  private missesCard(productId: Id): boolean {
    const { repo } = this.deps
    const have = new Set(repo.latestCards(productId).map(c => c.dimension))
    return repo.dimensionsOfProduct(productId).some(d => !have.has(d.key))
  }

  /**
   * Queues a write of the brief of `date` behind the writes of that brief already queued (the day's and 「立即更新」's
   * alike), and resolves with whether it went through. A failure is logged; once the scheduler stopped, nothing is written.
   */
  private queueBrief(date: string, label: string, write: () => Promise<unknown>): Promise<boolean> {
    const next = (this.briefs.get(date) ?? Promise.resolve(true)).then(async () => {
      if (this.stopped) return false
      try {
        await write()
        return true
      } catch (error) {
        this.log(`${label} of ${date} failed: ${messageOf(error)}`)
        return false
      }
    })
    this.briefs.set(date, next)
    void next.finally(() => { if (this.briefs.get(date) === next) this.briefs.delete(date) })
    return next
  }

  /** The latest day before `today`, within `MISSED_BRIEF_LOOKBACK_DAYS`, that has daily runs but no brief, and is neither being run nor having its brief written now. */
  private missedBriefDay(today: string): string | null {
    const { repo } = this.deps
    const dates = new Set(repo.listRuns(shiftDate(today, -MISSED_BRIEF_LOOKBACK_DAYS)).filter(r => r.kind === 'daily' && r.date < today).map(r => r.date))
    return [...dates].sort().reverse().find(date => !this.days.has(date) && !this.briefs.has(date) && !repo.getBrief(date)) ?? null
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

  private arm(when: Date, runTime: string): void {
    this.cancelTimer?.()
    this.armedRunTime = runTime
    this.cancelTimer = this.deps.clock.at(when, () => this.fire(when))
  }

  /**
   * The minute's look at the configured run time (it can change while Outpost runs): when it is not the one the timer was
   * set with, the timer is set again for the new one, within a minute of the change. A new time already past today, with
   * today not complete, runs today now (the catch-up of a start; a day already running is joined, and a completed one
   * never runs again). With today complete, the timer goes to tomorrow at the new time: today's moment must not run it again.
   */
  private checkRunTime(): void {
    if (this.stopped) return
    if (this.effectiveRunTime(false) === this.armedRunTime) return
    const runTime = this.runTime()
    const now = this.deps.clock.now()
    const completedToday = this.lastCompleted() === localDate(now)
    if (shouldCatchUp(now, runTime, this.lastCompleted())) this.launch(localDate(now))
    this.arm(completedToday ? tomorrowRunAt(now, runTime) : nextRunAt(now, runTime), runTime)
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
    this.arm(nextRunAt(at, runTime), runTime)
  }

  private lastCompleted(): string | null {
    const value = this.deps.repo.getSetting<unknown>(LAST_COMPLETED)
    return typeof value === 'string' ? value : null
  }

  /** The configured run time, or 08:00 if it is not a valid `HH:MM` (the calendar throws on those); `report` logs the latter. */
  private effectiveRunTime(report: boolean): string {
    const value = this.deps.settings().runTime
    if (typeof value === 'string' && RUN_TIME.test(value)) return value
    if (report) this.log(`runTime "${String(value)}" is not HH:MM; using ${DEFAULT_RUN_TIME}`)
    return DEFAULT_RUN_TIME
  }

  private runTime(): string {
    return this.effectiveRunTime(true)
  }
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** The local date `days` days after `date` (both `YYYY-MM-DD`). */
function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return localDate(new Date(y!, m! - 1, d! + days))
}
