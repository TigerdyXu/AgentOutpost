/**
 * Runs Outpost's research sessions. Each session gets a `Run` row and, in order: a budget check (a run the budget does
 * not allow is `skipped` with the reason), a place among at most `maxParallel` sessions at a time (the budget is checked
 * again once it gets one, so work queued behind a run that used the budget up does not start; recommendations need no
 * place, see `UNPOOLED`), its rounds with the agent
 * (a transient model or network failure retried, an agent that stops without `outpost_done` nudged once), and the
 * tokens it used priced into the run as they come.
 */
import { localDate } from '../../core/calendar.ts'
import { canSpend, costOf, type PriceTable } from '../../core/cost.ts'
import type { Id, Run, RunKind, RunStatus, Usage } from '../../core/types.ts'
import type { Repo } from '../../store/repo.ts'
import type { Clock, IconFetcher, SessionDriver, SessionOutcome, SessionSpec, ToolSpec } from '../ports.ts'

/** The settings a run reads when it needs them (they can change while Outpost runs). */
export interface RuntimeSettings {
  maxParallel: number
  dailyBudgetYuan: number
  sessionTimeoutMin: number
  prices: PriceTable
  /** null: the user's default model of DSH. */
  model: { provider: string; model: string } | null
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
}

/** One session, made once its run has a place to run: its title, its first message, and its tools. */
export interface SessionPlan {
  title: string
  prompt: string
  /** The session's tools; `onDone` is what their `outpost_done` calls. */
  tools(onDone: (summary: string) => void): ToolSpec[]
}

export const NUDGE_TEXT = '请继续完成任务；全部提交后调用 outpost_done。'
/** Retries after a transient failure, on top of the first try. */
export const TRANSIENT_RETRIES = 3
export const RETRY_DELAY_MS = 15_000
/** Sessions of runs that ended longer ago than this are archived. */
export const ARCHIVE_AFTER_DAYS = 7

const DAY_MS = 24 * 60 * 60 * 1000
/** Settings key: runs that ended before this moment (ISO) have had their sessions archived. */
const ARCHIVED_THROUGH = 'archivedSessionsThrough'
const DEFAULT_TIMEOUT_MIN = 30
/** The `error` of a run that failed only because Outpost was stopping: it was interrupted, not broken, and is run again. */
export const STOPPED_ERROR = '前哨已停止'
const INVALID_BUDGET = '每日预算设置无效'
const NOT_DONE = '提醒后仍没有调用 outpost_done，按已提交的内容收尾'
/**
 * Kinds that neither wait for nor take one of the `maxParallel` places: the user is watching a recommendation (§5.3
 * promises candidates in 1–3 minutes), and queued behind the daily runs it could wait for hours. The budget still applies.
 */
const UNPOOLED = new Set<RunKind>(['recommend'])
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
 * Why work counted toward `date` (and toward `productId`'s own budget, if it has one) may not start now, or null when it
 * may: the day's spending has reached `dailyBudgetYuan`, or the product's has reached its `dailyBudgetYuan`.
 */
export function budgetRefusal(repo: Repo, dailyBudgetYuan: number, date: string, productId: Id | null): string | null {
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
    const run = this.repo.createRun({ kind, date: scope.date ?? localDate(this.clock.now()), trackId: scope.trackId ?? null, productId: scope.productId ?? null })
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
    const cutoff = now.getTime() - ARCHIVE_AFTER_DAYS * DAY_MS
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
    const finish = (status: RunStatus, error: string | null): Run => {
      this.repo.updateRun(id, { status, error, endedAt: this.clock.now().toISOString() })
      return this.repo.getRun(id)!
    }
    const refused = this.refusal(run)
    if (refused) return finish('skipped', refused)
    const release = UNPOOLED.has(run.kind) ? (this.stopped ? null : () => {}) : await this.slot()
    if (!release) return finish('failed', STOPPED_ERROR)
    try {
      // Spending may have reached the budget while this run waited for its place.
      const late = this.refusal(run)
      if (late) return finish('skipped', late)
      let done = false
      const plan = build(id)
      const tools = plan.tools(() => { done = true })
      const sessionId = `outpost-${run.kind}-${id.slice(0, 8)}`
      this.repo.updateRun(id, { status: 'running', startedAt: this.clock.now().toISOString(), sessionId })
      const spec: SessionSpec = { sessionId, title: plan.title, prompt: plan.prompt, tools, model: this.settings().model ?? null }
      const used = noUsage()
      let outcome = await this.round(id, used, signal => this.driver.run(spec, signal))
      if (!done && CONTINUABLE.has(outcome.reason) && !this.stopped)
        outcome = await this.round(id, used, signal => this.driver.nudge(sessionId, NUDGE_TEXT, signal))
      if (done) return finish('done', null)
      if (this.stopped) return finish('failed', STOPPED_ERROR)
      if (CONTINUABLE.has(outcome.reason)) return finish('done', NOT_DONE) // what it handed in stands; it goes to the check like any other
      return finish('failed', this.describe(outcome))
    } catch (error) {
      return finish('failed', messageOf(error))
    } finally {
      release()
    }
  }

  /** One round (the first message or the nudge), tried again after transient failures. Usage and cost are stored after every try. */
  private async round(runId: Id, used: Usage, send: (signal: AbortSignal) => Promise<SessionOutcome>): Promise<SessionOutcome> {
    for (let retry = 0; ; retry++) {
      const outcome = await this.attempt(send)
      used.inputTokens += outcome.usage.inputTokens
      used.outputTokens += outcome.usage.outputTokens
      used.cacheReadTokens += outcome.usage.cacheReadTokens
      this.repo.updateRun(runId, { usage: { ...used }, costYuan: costOf(used, this.settings().prices) })
      if (!isTransient(outcome)) return outcome
      if (retry >= TRANSIENT_RETRIES) return { ...outcome, error: `${outcome.error}（已重试 ${retry} 次）` }
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
      case 'timeout': return `超过 ${this.timeoutMin()} 分钟没有结束，已停止`
      case 'blocked': return '会话被拦下，没有继续'
      case 'aborted': return '会话被取消'
      default: return outcome.error || '会话出错'
    }
  }

  // ---- budget, places, time ----

  /** Why the run may not start now, or null when it may. */
  private refusal(run: Run): string | null {
    return budgetRefusal(this.repo, this.settings().dailyBudgetYuan, run.date, run.productId)
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
