/**
 * Runs Outpost's research sessions. Each session gets a `Run` row and, in order: a budget check (a run the budget does
 * not allow is `skipped` with the reason; a run on a local or subscription model costs ¥0 and is never refused), a
 * place among at most `maxParallel` sessions at a time (the budget is checked again once it gets one, so work queued
 * behind a run that used the budget up does not start; recommendations and confirmations need no place, see
 * `UNPOOLED`), its rounds with the agent (a transient model or network failure retried, an agent that stops without
 * `outpost_done` nudged once), the tokens it used priced into the run as they come, and, once the run is settled
 * (`SessionPlan.settle`), its session let go of (`release`: the browser the research preset launched for it closes
 * then, before the next session takes its place). A check runs on the verify model and everything else on the research
 * model (`modelFor`), as configured when the session starts; its tokens are priced by that model's provider, so a run on a
 * local or subscription model costs ¥0 and takes nothing from the budget.
 */
import { localDate } from '../../core/calendar.ts'
import { canSpend, costOf, type PriceTable } from '../../core/cost.ts'
import { modelFor, type Billing, type ModelRef, type ModelSettings } from '../../core/models.ts'
import type { Id, Run, RunKind, RunStatus, Usage } from '../../core/types.ts'
import type { Repo } from '../../store/repo.ts'
import type { Clock, IconFetcher, SessionDriver, SessionOutcome, SessionSpec, ToolSpec } from '../ports.ts'
import { say } from '../../core/messages.ts'

/** The settings a run reads when it needs them (they can change while Outpost runs), the models of the four roles among them. */
export interface RuntimeSettings extends ModelSettings {
  maxParallel: number
  dailyBudgetYuan: number
  sessionTimeoutMin: number
  /**
   * How work on `model` is paid (null: DSH's default model, as it is now), by its provider (`billingOf`); `metered` when
   * DSH cannot say which model its default is.
   */
  billingFor(model: ModelRef | null): Billing
  /**
   * The prices of tokens used on `model` (null: DSH's default model) at `at`: the configured price table for a metered
   * provider, halved in DeepSeek's off-peak hours on a DeepSeek route (`pricesAt`); all 0 for a local or subscription one
   * (`pricesFor`).
   */
  pricesOf(model: ModelRef | null, at: Date): PriceTable
}

/** What the recommendation and baseline jobs (and the jobs after them) work with. */
export interface JobDeps {
  repo: Repo
  runner: JobRunner
  clock: Clock
  icons: IconFetcher
}

/** What a run is about, and the local day it counts in (default: today). */
export interface SessionScope {
  trackId?: Id | null
  productId?: Id | null
  /** `YYYY-MM-DD`. A run belongs to that day's brief and budget, whenever it actually runs. */
  date?: string
  /** What the user typed that the run is about (`Run.subject`). */
  subject?: string | null
}

/** One session, made once its run has a place to run: its title, its first message, and its tools. */
export interface SessionPlan {
  title: string
  prompt: string
  /** The session's tools; `onDone` is what their `outpost_done` calls. */
  tools(onDone: (summary: string) => void): ToolSpec[]
  /**
   * Acts on what the session handed in, given the run as it ended (status and error stored): called in the same
   * synchronous step that stores them, so nobody reads the run as over before it is settled (letting go of the session,
   * which comes after, can take a while). It may amend the run. A failure is logged; the run is left as it is then (as it
   * ended, unless `settle` changed it before failing).
   */
  settle?(run: Run): void
}

export const NUDGE_TEXT = '请继续完成任务；全部提交后调用 outpost_done。'
/** Retries after a transient failure, on top of the first try. */
export const TRANSIENT_RETRIES = 3
export const RETRY_DELAY_MS = 15_000
/**
 * How long a session's place waits for the session to be let go of (its browser closed) before the next session takes it
 * anyway: a release that hangs must not stop the day's runs. Wall-clock time, like the session time limit.
 */
export const RELEASE_WAIT_MS = 60_000
/**
 * Sessions of runs that ended before this many local days ago (counted from midnight) are archived, after each day's
 * run: Outpost writes a dozen sessions a day (research, checks, recommendations, topics), and a week of them crowded the
 * user's own out of DSH's session list (M1 defect 9). 1 keeps today's and yesterday's at hand, to open from 运行记录.
 */
export const ARCHIVE_AFTER_DAYS = 1

const DAY_MS = 24 * 60 * 60 * 1000
/** Settings key: runs that ended before this moment (ISO) have had their sessions archived. */
const ARCHIVED_THROUGH = 'archivedSessionsThrough'
const DEFAULT_TIMEOUT_MIN = 30
/** The `error` of a run that failed only because Outpost was stopping: it was interrupted, not broken, and is run again. */
export const STOPPED_ERROR = say('stopped')
const INVALID_BUDGET = say('budgetInvalid')
const NOT_DONE = say('notDone')
/**
 * Kinds that neither wait for nor take one of the `maxParallel` places: the user is watching a recommendation (§5.3
 * promises candidates in 1–3 minutes), or the confirmation of a product they added by name, and queued behind the daily
 * runs either could wait for hours. The budget still applies.
 */
const UNPOOLED = new Set<RunKind>(['recommend', 'identify'])
/** Rounds that ended this way may simply go on: the agent stopped talking, hit its output limit, or the host restarted. */
const CONTINUABLE = new Set<SessionOutcome['reason']>(['completed', 'max-tokens', 'interrupted'])

// Copied from superagent's `transient()` (src/executor/dsh.ts): network failures, rate limits and 5xx answers pass by themselves.
const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
  'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i')

/** Whether the round failed in a way that passes by itself (network, rate limit, an HTTP 408, 429 or 5xx), so trying again may help. */
export function isTransient(outcome: SessionOutcome): boolean {
  return outcome.reason === 'error' && PASSING.test(outcome.error ?? '')
}

/**
 * Why work on `model` counted toward `date` (and toward `productId`'s own budget, if it has one) may not start now, or
 * null when it may: the day's spending has reached `dailyBudgetYuan`, or the product's has reached its `dailyBudgetYuan`.
 * The budget guards money: work on a model that is not metered (local, the subscription) costs ¥0 and is never refused
 * by it, whatever has been spent.
 */
export function budgetRefusal(repo: Repo, settings: Pick<RuntimeSettings, 'dailyBudgetYuan' | 'billingFor'>, model: ModelRef | null, date: string, productId: Id | null): string | null {
  if (settings.billingFor(model) !== 'metered') return null
  const { dailyBudgetYuan } = settings
  if (!(typeof dailyBudgetYuan === 'number' && dailyBudgetYuan >= 0)) return INVALID_BUDGET
  const own = productId ? repo.getProduct(productId)?.dailyBudgetYuan : null
  const verdict = canSpend({
    spentToday: repo.spentOn(date),
    dailyBudget: dailyBudgetYuan,
    productSpentToday: productId ? repo.spentOn(date, productId) : 0,
    productBudget: typeof own === 'number' && own >= 0 ? own : null, // a budget that is not a number is no budget
  })
  return verdict.ok ? null : verdict.reason
}

const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

export class JobRunner {
  private readonly repo: Repo
  private readonly driver: SessionDriver
  private readonly clock: Clock
  private readonly settings: () => RuntimeSettings
  private readonly log: (message: string) => void
  /** Aborted by `stop`: every session in flight ends, every queued one fails. */
  private readonly lifetime = new AbortController()
  private active = 0
  private readonly waiting: (() => void)[] = []
  /** Sessions and background jobs not finished yet, as promises that never reject. */
  private readonly pending = new Set<Promise<void>>()

  /** @param deps.log - where failures of background work are reported (the plugin's logger); default `console.warn`. */
  constructor(deps: { repo: Repo; driver: SessionDriver; clock: Clock; settings: () => RuntimeSettings; log?: (message: string) => void }) {
    this.repo = deps.repo
    this.driver = deps.driver
    this.clock = deps.clock
    this.settings = deps.settings
    this.log = deps.log ?? (message => console.warn(`dsh-outpost: ${message}`))
  }

  /**
   * Runs one session to its end and returns its run as stored then. A run that could not go ahead or did not succeed
   * still resolves, with `status` `skipped` or `failed` and the reason in `error`; only a failure of the store rejects.
   */
  session(kind: RunKind, scope: SessionScope, build: (runId: Id) => SessionPlan): Promise<Run> {
    return this.start(kind, scope, build).finished
  }

  /** Like `session`, but answers at once with the new run (queued), for a caller that needs its id before the session ends. */
  start(kind: RunKind, scope: SessionScope, build: (runId: Id) => SessionPlan): { run: Run; finished: Promise<Run> } {
    const run = this.repo.createRun({
      kind, date: scope.date ?? localDate(this.clock.now()), trackId: scope.trackId ?? null, productId: scope.productId ?? null, subject: scope.subject ?? null,
    })
    const finished = this.execute(run, build)
    this.hold(finished)
    return { run, finished }
  }

  /** Lets `work` go on in the background: `idle` and `stop` wait for it, and a failure is logged rather than lost. */
  track(work: Promise<unknown>, label: string): void {
    this.hold(work.catch(error => { this.log(`${label} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`) }))
  }

  /** Aborts when `stop` is called: work outside the sessions (the brief's model call) ends with them. */
  get stopSignal(): AbortSignal { return this.lifetime.signal }

  /** Resolves once every session and tracked job, including those they start meanwhile, has finished. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }

  /** Ends every session in flight, fails the queued ones and those started from now on, and waits for all of it. */
  async stop(): Promise<void> {
    this.lifetime.abort()
    this.wake()
    await this.idle()
  }

  /**
   * Archives the sessions of runs that ended more than 7 days before `now`. Follow-up chats are the user's and stay.
   * Runs already looked at are remembered, so calling it again archives nothing twice; a session that cannot be archived
   * (DSH no longer has it, say) is logged and not tried again.
   */
  async archiveOld(now: Date): Promise<void> {
    // Midnight `ARCHIVE_AFTER_DAYS` days back: whatever ended yesterday stays, however late today's run ends.
    const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ARCHIVE_AFTER_DAYS).getTime()
    const through = Date.parse(this.repo.getSetting<string>(ARCHIVED_THROUGH) ?? '')
    const from = Number.isNaN(through) ? -Infinity : through // none yet, or unreadable: look at every run
    if (!(cutoff > from)) return
    for (const run of this.repo.listRuns('')) {
      if (!run.sessionId || !run.endedAt || run.kind === 'followup') continue
      const ended = Date.parse(run.endedAt)
      if (!(ended >= from && ended < cutoff)) continue
      try { await this.driver.archive(run.sessionId) }
      catch (error) { this.log(`could not archive session ${run.sessionId}: ${messageOf(error)}`) }
    }
    this.repo.setSetting(ARCHIVED_THROUGH, new Date(cutoff).toISOString())
  }

  // ---- one session ----

  private async execute(run: Run, build: (runId: Id) => SessionPlan): Promise<Run> {
    const id = run.id
    let plan: SessionPlan | undefined
    const finish = (status: RunStatus, error: string | null): Run => {
      this.repo.updateRun(id, { status, error, endedAt: this.clock.now().toISOString() })
      if (plan?.settle) {
        try { plan.settle(this.repo.getRun(id)!) }
        catch (failure) { this.log(`run ${id} could not be settled: ${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}`) }
      }
      return this.repo.getRun(id)!
    }
    const refused = this.refusal(run)
    if (refused) return finish('skipped', refused)
    const release = UNPOOLED.has(run.kind) ? (this.stopped ? null : () => {}) : await this.slot()
    if (!release) return finish('failed', STOPPED_ERROR)
    /** The run's session, once it may exist: from its first round on, whatever comes of it. */
    let opened: string | null = null
    try {
      // The model as configured now, when the session starts. Passed as is: a model DSH no longer offers is not swapped
      // for another; the session fails and says so.
      const model = this.modelOf(run)
      // Spending may have reached the budget while this run waited for its place.
      const late = this.refusal(run, model)
      if (late) return finish('skipped', late)
      let done = false
      plan = build(id)
      const tools = plan.tools(() => { done = true })
      const sessionId = `outpost-${run.kind}-${id.slice(0, 8)}`
      const started = this.clock.now()
      this.repo.updateRun(id, { status: 'running', startedAt: started.toISOString(), sessionId })
      opened = sessionId
      const spec: SessionSpec = { sessionId, title: plan.title, prompt: plan.prompt, tools, model }
      const used = noUsage()
      const priced = { model, at: started }
      let outcome = await this.round(id, priced, used, signal => this.driver.run(spec, signal))
      if (!done && CONTINUABLE.has(outcome.reason) && !this.stopped)
        outcome = await this.round(id, priced, used, signal => this.driver.nudge(sessionId, NUDGE_TEXT, signal))
      if (done) return finish('done', null)
      if (this.stopped) return finish('failed', STOPPED_ERROR)
      if (CONTINUABLE.has(outcome.reason)) return finish('done', NOT_DONE) // what it handed in stands; it goes to the check like any other
      return finish('failed', this.describe(outcome))
    } catch (error) {
      return finish('failed', messageOf(error))
    } finally {
      // After the run is stored as settled (every round over, the nudge included) and before its place goes to the next.
      if (opened) await this.letGo(opened)
      release()
    }
  }

  /**
   * Lets go of a session whose run is over (`SessionDriver.release`), waiting for it at most `RELEASE_WAIT_MS`; a failure
   * is logged and changes nothing of the run, and a release still going on then goes on alone.
   */
  private async letGo(sessionId: string): Promise<void> {
    const released = Promise.resolve()
      .then(() => this.driver.release(sessionId))
      .then(() => true, (error: unknown) => { this.log(`could not let go of session ${sessionId}: ${messageOf(error)}`); return true })
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), RELEASE_WAIT_MS) })
    try {
      if (!await Promise.race([released, late])) this.log(`session ${sessionId} is still being let go of after ${RELEASE_WAIT_MS / 1000} s; the next session goes ahead`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * One round (the first message or the nudge), tried again after transient failures. Usage (with the searches) and cost
   * are stored after every try, the cost at the prices of `priced.model`, the model the session runs on, as they were when
   * the run started (`priced.at`): a run is priced as peak or off-peak as a whole.
   */
  private async round(runId: Id, priced: { model: ModelRef | null; at: Date }, used: Usage, send: (signal: AbortSignal) => Promise<SessionOutcome>): Promise<SessionOutcome> {
    for (let retry = 0; ; retry++) {
      const outcome = await this.attempt(send)
      used.inputTokens += outcome.usage.inputTokens
      used.outputTokens += outcome.usage.outputTokens
      used.cacheReadTokens += outcome.usage.cacheReadTokens
      used.searches = (used.searches ?? 0) + (outcome.usage.searches ?? 0)
      this.repo.updateRun(runId, { usage: { ...used }, costYuan: costOf(used, this.settings().pricesOf(priced.model, priced.at)) })
      if (!isTransient(outcome)) return outcome
      if (retry >= TRANSIENT_RETRIES) return { ...outcome, error: say('retried', { reason: outcome.error ?? '', count: retry }) }
      if (this.stopped) return outcome
      await this.sleep(RETRY_DELAY_MS)
      if (this.stopped) return outcome
    }
  }

  /** Sends once, within the session time limit; a driver that throws counts as a failed round. */
  private async attempt(send: (signal: AbortSignal) => Promise<SessionOutcome>): Promise<SessionOutcome> {
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMin() * 60_000), this.lifetime.signal])
    try {
      return await send(signal)
    } catch (error) {
      return { reason: 'error', usage: noUsage(), error: messageOf(error) }
    }
  }

  private describe(outcome: SessionOutcome): string {
    switch (outcome.reason) {
      case 'timeout': return say('timeout', { minutes: this.timeoutMin() })
      case 'blocked': return say('blocked')
      case 'aborted': return say('aborted')
      default: return outcome.error || say('sessionError')
    }
  }

  // ---- budget, places, time ----

  /** The model the run's session works on: a check (a dossier's or a 专题's) on the verify model, everything else on the research model. */
  private modelOf(run: Run): ModelRef | null {
    return modelFor(run.kind === 'verify' || run.kind === 'topicCheck' ? 'verify' : 'research', this.settings())
  }

  /** Why the run may not start now on `model`, or null when it may. */
  private refusal(run: Run, model = this.modelOf(run)): string | null {
    return budgetRefusal(this.repo, this.settings(), model, run.date, run.productId)
  }

  /** Waits for a place among the sessions running; resolves with its release, or null once the runner stopped. */
  private async slot(): Promise<(() => void) | null> {
    while (!this.stopped && this.active >= this.limit()) await new Promise<void>(resolve => this.waiting.push(resolve))
    if (this.stopped) return null
    this.active++
    let held = true
    return () => {
      if (!held) return
      held = false
      this.active--
      this.wake()
    }
  }

  /** Every waiter looks again; those that still find no place wait again, in the same order. */
  private wake(): void {
    for (const resolve of this.waiting.splice(0)) resolve()
  }

  private limit(): number {
    const n = Math.floor(this.settings().maxParallel)
    return n >= 1 ? n : 1
  }

  private timeoutMin(): number {
    const min = this.settings().sessionTimeoutMin
    return typeof min === 'number' && min > 0 && Number.isFinite(min) ? min : DEFAULT_TIMEOUT_MIN
  }

  private get stopped(): boolean { return this.lifetime.signal.aborted }

  /** Waits `ms` on the clock, or less if the runner stops meanwhile. */
  private sleep(ms: number): Promise<void> {
    const signal = this.lifetime.signal
    if (signal.aborted) return Promise.resolve()
    return new Promise(resolve => {
      let cancel = () => {}
      const end = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = () => { cancel(); end() }
      signal.addEventListener('abort', onAbort, { once: true })
      cancel = this.clock.at(new Date(this.clock.now().getTime() + ms), end)
    })
  }

  private hold(work: Promise<unknown>): void {
    const settled = work.then(() => {}, () => {})
    this.pending.add(settled)
    void settled.then(() => { this.pending.delete(settled) })
  }
}
