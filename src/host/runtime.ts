/**
 * Outpost's composition root: one `Runtime` per load of the plugin owns the data directory (and its lock), the store, the
 * two DSH adapters, the job runner and the scheduler, and serves the panel's API (`api.ts`) under `/outpost/api/`.
 *
 * `start` registers the routes and starts the daily timer; `stop` takes the routes down, ends the sessions in flight
 * (their runs fail with `STOPPED_ERROR`, so the next start picks them up), waits for everything begun to settle, takes
 * the research tools back from DSH's agents, closes the store and releases the lock.
 */
import type { Context } from '@deepseek-ai/cordis'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { OutpostConfig } from '../config.ts'
import { localDate } from '../core/calendar.ts'
import { pricesFor, type PriceTable } from '../core/cost.ts'
import { billingOf, modelFor, type ModelRef } from '../core/models.ts'
import { openDb, lockDataDir, type Db } from '../store/db.ts'
import { Repo } from '../store/repo.ts'
import { createApi } from './api.ts'
import { SystemClock } from './clock.ts'
import { DshModelClient } from './dsh-model.ts'
import { DshSessionDriver } from './dsh-sessions.ts'
import { registerRoutes } from './http.ts'
import { NodeIconFetcher } from './icons.ts'
import { baselineProducts, type BaselineDeps } from './jobs/baseline.ts'
import { runDailyProduct } from './jobs/daily.ts'
import { JobRunner, STOPPED_ERROR, type JobDeps, type RuntimeSettings } from './jobs/runner.ts'
import { appendLate, synthesizeBrief, type BriefDeps } from './jobs/synthesize.ts'
import { verifyProduct } from './jobs/verify.ts'
import type { Clock, IconFetcher, ModelClient, SessionDriver } from './ports.ts'
import { Scheduler, type SchedulerSettings } from './scheduler.ts'
import { researchTools } from './tools.ts'

/** Follow-up chats younger than this many days get their tool back on start. */
export const REBIND_FOLLOWUPS_DAYS = 30

/** What the plugin says when another Outpost (another DSH, or a second copy of the plugin) holds the data directory. */
export const lockedMessage = (dataDir: string) => `数据目录被另一个前哨进程占用：${dataDir}`

/** The parts a test puts in place of the real ones; each one left out is built on DSH (or the wall clock). */
export interface RuntimeParts {
  driver?: SessionDriver
  model?: ModelClient
  clock?: Clock
  icons?: IconFetcher
}

/** Everything a run and the scheduler read from the configuration, read anew on each use. */
export type Settings = RuntimeSettings & SchedulerSettings

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Makes `dir` (and its parents) if missing, and private to this user either way. */
function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

export class Runtime {
  readonly dataDir: string
  readonly iconsDir: string
  readonly workspaceDir: string
  readonly repo: Repo
  readonly clock: Clock
  readonly driver: SessionDriver
  readonly model: ModelClient
  readonly icons: IconFetcher
  readonly runner: JobRunner
  readonly scheduler: Scheduler
  /** What the jobs work with: the store, the runner, the clock, the icons, and the check a baseline ends with. */
  readonly jobs: BaselineDeps
  /** What the brief is written with. */
  readonly briefs: BriefDeps
  private readonly db: Db
  private readonly unlock: () => void
  private unregister: (() => void) | null = null
  private stopping: Promise<void> | null = null

  /**
   * Takes the data directory: makes it (and `icons/`, `workspace/`) private, locks it, and opens the store.
   * @throws Error(`lockedMessage(dataDir)`) when another Outpost holds the directory; any other failure as it is.
   */
  constructor(readonly ctx: Context, readonly config: OutpostConfig, parts: RuntimeParts = {}) {
    this.dataDir = config.dataDir
    this.iconsDir = join(this.dataDir, 'icons')
    this.workspaceDir = join(this.dataDir, 'workspace')
    privateDir(this.dataDir)
    try {
      this.unlock = lockDataDir(this.dataDir, error => {
        // The lock went stale while this process held it (a laptop asleep past the 30 s window, say): another copy may
        // now take the directory. Nothing to undo here; say so, and keep running.
        ctx.logger.error('dsh-outpost: the lock on the data directory %s could not be kept; another Outpost may open it now: %s', this.dataDir, messageOf(error))
      })
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ELOCKED') throw new Error(lockedMessage(this.dataDir), { cause: error })
      throw error
    }
    try {
      privateDir(this.iconsDir)
      privateDir(this.workspaceDir)
      this.db = openDb(join(this.dataDir, 'outpost.sqlite'))
    } catch (error) {
      this.unlock()
      throw error
    }

    const log = (message: string) => this.log(message)
    this.clock = parts.clock ?? new SystemClock(error => this.log(`a timer failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
    this.repo = new Repo(this.db, () => this.clock.now())
    this.driver = parts.driver ?? new DshSessionDriver(ctx, this.workspaceDir)
    this.model = parts.model ?? new DshModelClient(ctx, () => modelFor('brief', this.settings()))
    this.icons = parts.icons ?? new NodeIconFetcher(this.iconsDir)
    this.runner = new JobRunner({ repo: this.repo, driver: this.driver, clock: this.clock, settings: () => this.settings(), log })
    const jobs: JobDeps = { repo: this.repo, runner: this.runner, clock: this.clock, icons: this.icons }
    this.jobs = { ...jobs, verifyProduct: (productId, scope) => verifyProduct(jobs, productId, scope) }
    this.briefs = { repo: this.repo, model: this.model, clock: this.clock, settings: () => this.settings(), stop: this.runner.stopSignal }
    this.scheduler = new Scheduler({
      clock: this.clock,
      repo: this.repo,
      settings: () => this.settings(),
      runDailyProduct: (productId, date) => runDailyProduct(jobs, productId, date),
      synthesize: date => synthesizeBrief(this.briefs, date),
      appendLate: (date, productId) => appendLate(this.briefs, date, productId),
      archiveOld: now => this.runner.archiveOld(now),
      rebaseline: productIds => baselineProducts(this.jobs, productIds),
      verifyProduct: (productId, date) => verifyProduct(jobs, productId, 'daily', date),
      log,
    })
  }

  /** The configured settings as they are now (the volatile ones can change while Outpost runs). */
  settings(): Settings {
    const c = this.config
    return {
      runTime: c.runTime.get(),
      maxParallel: c.maxParallel.get(),
      dailyBudgetYuan: c.dailyBudgetYuan.get(),
      sessionTimeoutMin: c.sessionTimeoutMin.get(),
      model: c.model.get() ?? null,
      verifyModel: c.verifyModel.get() ?? null,
      briefModel: c.briefModel.get() ?? null,
      followupModel: c.followupModel.get() ?? null,
      pricesOf: model => this.pricesOf(model, c.prices.get()),
    }
  }

  /** DSH's default model now (what a role with no model chosen runs on), or null when DSH cannot say. */
  defaultModel(): ModelRef | null {
    try {
      const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
      return { provider, model }
    } catch (error) {
      this.log(`could not read the default model of DSH: ${messageOf(error)}`)
      return null
    }
  }

  /**
   * The prices of tokens used on `model` (null: DSH's default model, as it is now): `table` when its provider is metered,
   * nothing when it is local or the subscription (`billingOf`, by the provider's id and DSH's name for it). When DSH
   * cannot say which model is its default, `table`: an estimate on the safe side of the budget.
   */
  private pricesOf(model: ModelRef | null, table: PriceTable): PriceTable {
    const route = model ?? this.defaultModel()
    if (!route) return table
    let name: string | undefined
    try { name = this.ctx.llm.listProviders().find(p => p.id === route.provider)?.name }
    catch { /* known by its id alone */ }
    return pricesFor(billingOf(route.provider, name), table)
  }

  /** Today's local date, `YYYY-MM-DD`. */
  today(): string { return localDate(this.clock.now()) }

  /**
   * Whether research sessions can open pages in a browser: DSH has the browser-use service (`dsh-browser-use`) and a
   * browser provider registered with it (`providerName`, docs/subsystems/browser-use.md). Without one, pages behind a
   * verification wall (公众号, 小红书, 知乎) stay unopened and their findings 「待确认」.
   */
  browserAvailable(): boolean {
    const service = this.ctx.get('browserUse') as { providerName?: unknown } | null | undefined
    if (service === undefined || service === null) return false
    return 'providerName' in service ? service.providerName !== undefined : true
  }

  /** Writes to DSH's log. */
  log(message: string): void {
    this.ctx.logger.warn('dsh-outpost: %s', message)
  }

  /** Lets `work` go on after the request that started it: `stop` waits for it, and a failure is logged. */
  background(work: Promise<unknown>, label: string): void {
    this.runner.track(work, label)
  }

  /**
   * Starts serving: runs an earlier process left `queued` or `running` are marked interrupted, follow-up chats get their
   * tool back, the routes are registered, and the scheduler starts (catching up on a missed day). Calling it again does
   * nothing.
   */
  start(): void {
    if (this.unregister || this.stopping) return
    this.reclaimInterruptedRuns()
    this.rebindFollowups()
    this.unregister = registerRoutes(this.ctx, createApi(this))
    this.scheduler.start()
  }

  /** Stops serving and lets go of the data directory, after everything begun has settled. Calling it again is harmless. */
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.unregister?.()
      this.unregister = null
      this.scheduler.stop()
      try {
        await this.runner.stop()
        await this.scheduler.idle()
        await this.runner.idle() // what the scheduler's last steps started
      } finally {
        this.driver.close()
        this.db.close()
        this.unlock()
      }
    })()
    return this.stopping
  }

  /**
   * Runs left `queued` or `running` were cut short when the process that ran them ended (the lock says no other is
   * alive). They become `failed` with `STOPPED_ERROR`: interrupted, not broken, so the scheduler runs them again, and
   * nothing shows them as still running.
   */
  private reclaimInterruptedRuns(): void {
    const now = this.clock.now().toISOString()
    for (const run of this.repo.activeRuns()) this.repo.updateRun(run.id, { status: 'failed', error: STOPPED_ERROR, endedAt: run.endedAt ?? now })
  }

  /** Gives each 追问 chat of the last `REBIND_FOLLOWUPS_DAYS` days its `outpost_read` again (tool bindings live in memory). */
  private rebindFollowups(): void {
    const now = this.clock.now()
    const since = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - REBIND_FOLLOWUPS_DAYS))
    for (const run of this.repo.listRuns(since).reverse()) {
      if (run.kind !== 'followup' || run.status !== 'done' || !run.sessionId || !run.productId) continue
      try {
        this.driver.rebind(run.sessionId, researchTools('followup', {
          repo: this.repo, runId: run.id, trackId: null, productId: run.productId, now: () => this.clock.now(), icons: this.icons, onDone: () => {},
        }))
      } catch (error) {
        this.log(`could not give follow-up chat ${run.sessionId} its tools again: ${messageOf(error)}`)
      }
    }
  }
}
