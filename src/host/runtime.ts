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
import { costOf, pricesAt, pricesFor } from '../core/cost.ts'
import { billingOf, modelFor, onDeepSeek, type Billing, type ModelRef } from '../core/models.ts'
import type { Axes, Id, Landscape, TopicVersion, Usage } from '../core/types.ts'
import { openDb, lockDataDir, type Db } from '../store/db.ts'
import { Repo } from '../store/repo.ts'
import { createApi } from './api.ts'
import { SystemClock } from './clock.ts'
import { DshModelClient } from './dsh-model.ts'
import {
  chooseResearchPreset, DshSessionDriver, profileBrowserProvider, researchPresetRuns, type AgentPresets, type ResearchPresetChoice,
} from './dsh-sessions.ts'
import { registerRoutes } from './http.ts'
import { NodeIconFetcher } from './icons.ts'
import { baselineProducts, type BaselineDeps } from './jobs/baseline.ts'
import { runDailyProduct } from './jobs/daily.ts'
import { drawLandscape, needsDrawing } from './jobs/landscape.ts'
import { recommendAndWait } from './jobs/recommend.ts'
import { runTopic, topicDue } from './jobs/topic.ts'
import { WEEKLY_REFINE, weeklyDue } from './jobs/weekly.ts'
import { JobRunner, STOPPED_ERROR, type JobDeps, type RuntimeSettings } from './jobs/runner.ts'
import { appendLate, synthesizeBrief, type BriefDeps } from './jobs/synthesize.ts'
import { verifyProduct } from './jobs/verify.ts'
import type { Clock, IconFetcher, ModelClient, SessionDriver } from './ports.ts'
import { Scheduler, type SchedulerSettings } from './scheduler.ts'
import { researchTools } from './tools.ts'
import { say } from '../core/messages.ts'

/** DSH's browser providers (`@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` and its siblings), not the service. */
const BROWSER_PROVIDER = /^@deepseek-ai\/dsh-(?:experimental-)?browser-use-./

/** Follow-up chats younger than this many days get their tool back on start. */
export const REBIND_FOLLOWUPS_DAYS = 30

/** What the plugin says when another Outpost (another DSH, or a second copy of the plugin) holds the data directory. */
export const lockedMessage = (dataDir: string) => say('dataDirLocked', { dir: dataDir })

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
  /** 专题 rounds under way, by topic (`researchTopic`). */
  private readonly topicRounds = new Map<Id, Promise<TopicVersion | null>>()
  /** Maps being drawn, by track (`drawMap`). */
  private readonly drawing = new Map<Id, Promise<Landscape | null>>()
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
      drawMaps: date => this.drawMaps(date),
      suggestWeekly: date => this.suggestWeekly(date),
      updateTopics: date => this.updateTopics(date),
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
      billingFor: model => this.billingFor(model),
      pricesOf: (model, at) => this.pricesOf(model, at),
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
   * The prices of `model`'s tokens at `at` (`RuntimeSettings.pricesOf`). A model DSH cannot name (its default unknown) is
   * taken to be on DeepSeek, like the price table it is estimated with.
   */
  private pricesOf(model: ModelRef | null, at: Date) {
    const route = model ?? this.defaultModel()
    return pricesAt(pricesFor(this.billingFor(model), this.config.prices.get()), at, route === null || onDeepSeek(route.provider))
  }

  /**
   * How work on `model` is paid (null: DSH's default model, as it is now), by its provider's id and DSH's name for it
   * (`billingOf`). When DSH cannot say which model is its default: metered, on the safe side, so that the budget still
   * holds the work and its tokens are estimated with the price table.
   */
  private billingFor(model: ModelRef | null): Billing {
    const route = model ?? this.defaultModel()
    if (!route) return 'metered'
    let name: string | undefined
    try { name = this.ctx.llm.listProviders().find(p => p.id === route.provider)?.name }
    catch { /* known by its id alone */ }
    return billingOf(route.provider, name)
  }

  /** Today's local date, `YYYY-MM-DD`. */
  today(): string { return localDate(this.clock.now()) }

  /**
   * Whether research sessions can open pages in a browser. Outpost's own browser lives inside the research preset
   * (cordis.patch.yml: the browser-use service and its Playwright provider in an isolated group), so it is on when a
   * revision of `outpost-researcher` DSH holds has a browser provider running (`researchPresetRuns`). A provider
   * registered for the whole profile counts too, a Playwright one beside the preset's own included: research sessions
   * then run on the preset without a browser (`researchPreset`), and the profile's Playwright is the one they get.
   * Without a browser, pages behind a verification wall (公众号, 小红书, 知乎) stay unopened and their findings 「待确认」.
   */
  browserAvailable(): boolean {
    const profile = profileBrowserProvider(this.ctx)
    const presets = this.ctx.get('agentPresets') as AgentPresets | null | undefined
    try {
      return profile !== null || researchPresetRuns(presets, name => BROWSER_PROVIDER.test(name))
    } catch (error) {
      this.log(`could not read the composition of the research preset: ${messageOf(error)}`)
      return profile !== null
    }
  }

  /**
   * The preset new research sessions are made on now, and why not the one with the browser (`chooseResearchPreset`).
   * When the browser preset did not load (its packages are not installed) or a Playwright browser for the whole profile
   * clashes with its own, research runs on the preset without a browser; 设置 says so (`browserMissing`). Only when that
   * one does not load either can no research session start: every recommendation, baseline, check and daily run then
   * fails at once with `RESEARCH_PRESET_BROKEN`, and 设置 says that instead (`researchBroken`).
   */
  researchPreset(): Promise<ResearchPresetChoice> {
    return chooseResearchPreset(this.ctx)
  }

  /**
   * Draws the track's map now, for today (`drawLandscape`; `axes`: the user's, from 换轴), or joins the drawing of it
   * under way. Resolves with the drawing, or null when none was made.
   */
  drawMap(trackId: Id, axes: Axes | null = null): Promise<Landscape | null> {
    const running = this.drawing.get(trackId)
    if (running) return running
    const work = drawLandscape(this.briefs, trackId, this.today(), axes).finally(() => { this.drawing.delete(trackId) })
    this.drawing.set(trackId, work)
    return work
  }

  /** Whether the track's map is being drawn. */
  isDrawing(trackId: Id): boolean { return this.drawing.has(trackId) }

  /**
   * After a day's brief: draws again, one after another, the maps of the tracks that are on whose dossiers changed since
   * their last drawing (`needsDrawing`), for `date`. A track whose map is being drawn already is left to that drawing.
   */
  private async drawMaps(date: string): Promise<void> {
    for (const track of this.repo.listTracks()) {
      if (this.runner.stopSignal.aborted) return // stopping: the next day's brief draws what is left
      if (track.status !== 'active' || this.drawing.has(track.id) || !needsDrawing(this.repo, track)) continue
      const work = drawLandscape(this.briefs, track.id, date).finally(() => { this.drawing.delete(track.id) })
      this.drawing.set(track.id, work)
      await work
    }
  }

  /**
   * After a day's brief and maps: runs the weekly recommendation (M2.2) of each track that is due on `date` (`weeklyDue`),
   * one after another, so that each sees what the ones before it spent against the day's budget. Their candidates wait
   * under 「候选推荐」, as a 「再推荐一批」's do.
   */
  private async suggestWeekly(date: string): Promise<void> {
    for (const track of this.repo.listTracks()) {
      if (this.runner.stopSignal.aborted) return
      if (track.status !== 'active' || !weeklyDue(this.repo, track, date)) continue
      try { await recommendAndWait(this.jobs, track.id, WEEKLY_REFINE) }
      catch (error) { this.log(`the weekly suggestions of track ${track.id} did not start: ${messageOf(error)}`) }
    }
  }

  /**
   * Runs a round of the 专题 now, for today (`runTopic`), or joins the one under way. Resolves with the version written,
   * or null when the round was rejected.
   */
  researchTopic(topicId: Id, date = this.today()): Promise<TopicVersion | null> {
    const running = this.topicRounds.get(topicId)
    if (running) return running
    const work = runTopic(this.jobs, topicId, date).finally(() => { this.topicRounds.delete(topicId) })
    this.topicRounds.set(topicId, work)
    return work
  }

  /** Whether a round of the topic is under way. */
  isResearching(topicId: Id): boolean { return this.topicRounds.has(topicId) }

  /**
   * After the day's brief, maps and weekly suggestions: runs, one after another, a round of each topic due (`topicDue`):
   * a weekly one whose newest version is a week old, or a first round that did not finish before.
   */
  private async updateTopics(date: string): Promise<void> {
    for (const track of this.repo.listTracks()) {
      if (track.status !== 'active') continue
      for (const topic of this.repo.topicsOfTrack(track.id)) {
        if (this.runner.stopSignal.aborted) return
        if (this.topicRounds.has(topic.id) || !topicDue(this.repo, topic, date)) continue
        try { await this.researchTopic(topic.id, date) }
        catch (error) { this.log(`the topic ${topic.id} could not be updated: ${messageOf(error)}`) }
      }
    }
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
    this.repo.rejectTopicDrafts(STOPPED_ERROR) // a round the last Outpost did not see to its end
    this.driver.onChatUsage((sessionId, used) => { this.chargeChat(sessionId, used) })
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

  /**
   * Adds one reply or one search of a 追问 chat to the chat's run, at the prices of the follow-up model at this moment (a
   * reply off-peak costs half). The run keeps the date the chat started: a chat taken up again another day adds to it.
   */
  private chargeChat(sessionId: string, used: Usage): void {
    const run = this.repo.runOfSession(sessionId)
    if (!run || run.kind !== 'followup') return
    const total: Usage = {
      inputTokens: run.usage.inputTokens + used.inputTokens,
      outputTokens: run.usage.outputTokens + used.outputTokens,
      cacheReadTokens: run.usage.cacheReadTokens + used.cacheReadTokens,
      searches: (run.usage.searches ?? 0) + (used.searches ?? 0),
    }
    const cost = costOf(used, this.pricesOf(modelFor('followup', this.settings()), this.clock.now()))
    this.repo.updateRun(run.id, { usage: total, costYuan: Math.round((run.costYuan + cost) * 10_000) / 10_000 })
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
