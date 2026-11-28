/**
 * `SessionDriver` on DSH: Outpost's research sessions are ordinary DSH sessions in the 「前哨」 workspace, running the
 * `outpost-researcher` preset, or `outpost-researcher-basic` (the same without the browser) when that one cannot be used
 * (`chooseResearchPreset`); a 追问 chat runs DSH's `standard` preset instead: it is the user's own conversation, design
 * §7.7. Each gets the `outpost_*` tools of its round on its own agent, and is told what to do with a message of Outpost's
 * own (`source.kind: 'dsh-outpost'`), never one posing as the user. A round ends with the end of the turn that took its
 * message; what it cost is the usage of that turn's assistant messages.
 *
 * Outpost makes a research session's agent itself (`ctx.agents.create`) and keeps its handle, so that `release` can end
 * the live agent once the run is over: that closes the browser the preset launched for it, and it gives up on a creation
 * that outlasts the run's time limit (a browser that never starts). Every agent on a research preset, made by Outpost or
 * by DSH reopening a research session, is refused the one browser tool that runs arbitrary code (`UNSAFE_BROWSER_TOOL`).
 * A 追问 chat is made by DSH's session controller, as any chat of the user's, and stays.
 *
 * Every DSH value comes through `ctx` (session controller, workspace registry, persistence, agents, presets); this file
 * imports only DSH types.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { MessageId, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { z } from 'zod'
import type { Usage } from '../core/types.ts'
import type { SessionDriver, SessionOutcome, SessionSpec, ToolSpec } from './ports.ts'
import { say } from '../core/messages.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A message Outpost sends into one of its sessions: a research brief, a nudge, or the question of a follow-up chat. */
    'dsh-outpost': { readonly kind: 'dsh-outpost'; readonly form: 'relay' }
  }
}

/** Every Outpost session id starts with this; the tools go only to sessions that carry it. */
export const SESSION_PREFIX = 'outpost-'
/** The research preset (cordis.patch.yml), with the browser fallback; research runs on it whenever it can be used. */
export const AGENT_PRESET = 'outpost-researcher'
/**
 * The same research preset without the browser group (cordis.patch.yml), so that it loads without the browser packages,
 * which the Desktop does not ship and a plain `dsh plugin add` of Outpost does not install. Research runs on it when
 * `AGENT_PRESET` cannot be used (`chooseResearchPreset`); a page behind a verification wall then stays unopened and its
 * finding 「待确认」, unless the profile has a browser of its own.
 */
export const BASIC_AGENT_PRESET = 'outpost-researcher-basic'
/** Every preset a research session runs on. */
export const RESEARCH_PRESETS: readonly string[] = [AGENT_PRESET, BASIC_AGENT_PRESET]
/**
 * The preset of a 追问 chat: DSH's own `standard` agent (`packages/bundle/web-app/presets/standard.patch.yml` in the dsh
 * source), which the desktop and web profiles compose, with `outpost_read` added.
 */
export const FOLLOWUP_PRESET = 'standard'
/** Title of the DSH workspace the sessions live in. */
export const WORKSPACE_TITLE = '前哨'

/**
 * What a research run fails with when neither research preset can compose a session (`chooseResearchPreset`). A missing
 * browser no longer stops research (it runs without one), so this is something deeper, which the user cannot fix from a
 * sentence here: it says what stops and where the details are (what DSH said of each preset is in the log).
 */
export const RESEARCH_PRESET_BROKEN = say('presetBroken')
/** DSH's Playwright browser provider, as the research preset composes it (cordis.patch.yml). */
export const PLAYWRIGHT_MODULE = '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
/** The name that provider registers with browser use, which is also the MCP server name its tools are reached by. */
export const PLAYWRIGHT_PROVIDER = 'playwright-mcp'
/**
 * The Playwright MCP tool that runs arbitrary JavaScript in the Playwright server process (「RCE-equivalent」, in
 * Playwright's own README). A research session reads pages nobody vetted, and its tool calls run without approval, so it
 * is refused there; opening, reading and clicking through pages (`browser_navigate`, `browser_snapshot`, …) stay.
 */
export const UNSAFE_BROWSER_TOOL = `mcp__${PLAYWRIGHT_PROVIDER}__browser_run_code_unsafe`
/** What a research session's model is told when it calls `UNSAFE_BROWSER_TOOL`. */
export const RESEARCH_TOOL_REFUSED = '前哨的调研会话不能用这个工具'
/** How the id of a 追问 chat begins (`src/host/followup.ts`); every other Outpost session is a research one. */
const FOLLOWUP_SESSION_PREFIX = `${SESSION_PREFIX}followup-`

/**
 * Whether `agent` is built on a research preset (either of `RESEARCH_PRESETS`), wherever it was made: by Outpost
 * (`createOwned`), or by DSH reopening a research session (Desktop restoring its last page at startup, the user opening one
 * from the sidebar or 运行记录). The one without a browser counts too: a browser turned on for the whole profile reaches
 * its sessions, which read pages nobody vetted all the same. Told by the preset id DSH keeps in the session's durable
 * header (`SessionHeader.agentPreset`, restored on resume); a session whose header names none (or an agent without one to
 * read) by its id: an Outpost session that is not a 追问 chat.
 */
export function isResearchAgent(agent: Pick<Agent, 'id'> & { readonly session?: { readonly header?: { readonly agentPreset?: string } } }): boolean {
  const preset = agent.session?.header?.agentPreset
  if (preset !== undefined) return RESEARCH_PRESETS.includes(preset)
  return agent.id.startsWith(SESSION_PREFIX) && !agent.id.startsWith(FOLLOWUP_SESSION_PREFIX)
}

/**
 * What Outpost uses of DSH's preset registry (`ctx.agentPresets`, package `@deepseek-ai/dsh-agent-preset-registry`):
 * whether a preset can compose a session (`resolve`, which reports a failed activation as `broken` instead of throwing),
 * composing a new agent from it during its setup, and which modules each retained revision has running.
 */
export interface AgentPresets {
  /** Registers a preset definition (M2.4: the browser one), resolving with its disposer once it loaded or failed. */
  register?(definition: { id: string; plugins: readonly unknown[] }): Promise<() => Promise<void>>
  resolve(id: string): Promise<{ id: string; broken?: string }>
  mount(agentCtx: Context, id: string): Promise<{ id: string }>
  inspectCompositions(): readonly { readonly id: string; readonly modules: readonly { readonly moduleName: string }[] }[]
}

/**
 * Whether a revision of the research preset with the browser (`AGENT_PRESET`) that DSH holds has a module running that
 * passes `test` (`inspectCompositions` lists active rows only; a preset whose rows failed has no revision).
 */
export function researchPresetRuns(presets: AgentPresets | null | undefined, test: (moduleName: string) => boolean): boolean {
  return presets?.inspectCompositions().some(c => c.id === AGENT_PRESET && c.modules.some(m => test(m.moduleName))) ?? false
}

/**
 * The browser provider registered for the whole profile (`browserUse.providerName`, docs/subsystems/browser-use.md): its
 * name, `true` when the service does not say, or null when there is none.
 */
export function profileBrowserProvider(ctx: Context): string | true | null {
  const service = ctx.get('browserUse') as { providerName?: unknown } | null | undefined
  if (service === undefined || service === null) return null
  if (!('providerName' in service)) return true
  return service.providerName === undefined ? null : String(service.providerName)
}

/** Which preset new research sessions are created on now, and why not the other (`chooseResearchPreset`). */
export interface ResearchPresetChoice {
  /** `AGENT_PRESET`, `BASIC_AGENT_PRESET`, or null when neither can compose a session: then no research runs. */
  readonly preset: string | null
  /** Why `AGENT_PRESET` cannot be used, in DSH's words, or null when it is the one. */
  readonly browserProblem: string | null
  /** Why neither can, in DSH's words, or null when one can. */
  readonly problem: string | null
}

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error)

/** DSH's own diagnostic of a preset (`resolve`: a row that did not load; a preset it does not know), or null when it composes. */
async function presetProblem(presets: AgentPresets, id: string): Promise<string | null> {
  try {
    return (await presets.resolve(id)).broken ?? null
  } catch (error) {
    return messageOf(error)
  }
}

/**
 * Why the research preset with the browser cannot be used now, or null when it can: DSH's diagnostic of it (a row that did
 * not load, as when the browser packages are not installed), or a Playwright browser registered for the whole profile
 * beside the preset's own: both would start an MCP server named `playwright-mcp` for the session, and DSH refuses the
 * second only while creating the session, after it has written it. A registry that cannot say whether they clash counts
 * as a clash: the preset without a browser has nothing to clash with.
 */
async function browserPresetProblem(ctx: Context, presets: AgentPresets): Promise<string | null> {
  const broken = await presetProblem(presets, AGENT_PRESET)
  if (broken !== null) return broken
  try {
    if (profileBrowserProvider(ctx) === PLAYWRIGHT_PROVIDER && researchPresetRuns(presets, name => name === PLAYWRIGHT_MODULE)) {
      return `a Playwright browser registered for the whole profile ("${PLAYWRIGHT_PROVIDER}") beside the preset's own`
    }
    return null
  } catch (error) {
    return messageOf(error)
  }
}

/**
 * The preset a new research session is created on now: the one with the browser (`AGENT_PRESET`) when it can be used;
 * else the same without it (`BASIC_AGENT_PRESET`), as when the browser packages are not installed (a plain `dsh plugin
 * add` of Outpost) or the profile's own Playwright clashes with the preset's (whose browser then reaches the session); only
 * when that one cannot compose either is there none, and research is broken. Asked before each new research session, so a
 * profile fixed (and DSH restarted) is picked up without restarting Outpost; never throws.
 */
export async function chooseResearchPreset(ctx: Context): Promise<ResearchPresetChoice> {
  const presets = ctx.get('agentPresets') as AgentPresets | null | undefined
  if (!presets) {
    const missing = 'DSH has no agent preset registry'
    return { preset: null, browserProblem: missing, problem: missing }
  }
  const browserProblem = await browserPresetProblem(ctx, presets)
  if (browserProblem === null) return { preset: AGENT_PRESET, browserProblem: null, problem: null }
  const basicProblem = await presetProblem(presets, BASIC_AGENT_PRESET)
  if (basicProblem === null) return { preset: BASIC_AGENT_PRESET, browserProblem, problem: null }
  return { preset: null, browserProblem, problem: `${AGENT_PRESET}: ${browserProblem}; ${BASIC_AGENT_PRESET}: ${basicProblem}` }
}

/**
 * The JSON Schema the model sees for a tool's arguments. It describes what the tool accepts (`io: 'input'`): a field with a
 * default is optional, a `.nullish()` one may be null or left out. DSH does not check arguments against it (only `execute`
 * does, with readable errors); it only guides the model. It is copied to plain JSON: zod adds a hidden `~standard` key, and
 * DSH refuses such an object where it copies tool schemas losslessly (`tools.schemas()`, used by code-execution mode).
 */
export function toolParameters(schema: z.ZodType): Record<string, unknown> {
  return JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: 'input' }))) as Record<string, unknown>
}

/**
 * Adds one model call's token accounting, as DSH reports it, to `total`. DSH counts input disjointly (`TokenUsage` in
 * `@deepseek-ai/dsh-llm`): `inputTokens` is the input that missed the cache, `cacheReadTokens` the input read from it, and
 * `cacheWriteTokens` the input written to it, which is billed as a miss. So nothing is subtracted.
 */
export function addUsage(total: Usage, usage: TokenUsage | undefined): void {
  if (!usage) return
  total.inputTokens += usage.inputTokens + (usage.cacheWriteTokens ?? 0)
  total.outputTokens += usage.outputTokens
  total.cacheReadTokens += usage.cacheReadTokens ?? 0
}

const noUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })

/**
 * The event DSH's DeepSeek search provider (`@deepseek-ai/dsh-web-search-deepseek`) appends to the session whose agent
 * searched, once per search request: a hidden model call whose usage DSH drops. Outpost counts these (`Usage.searches`).
 */
export const SEARCH_EVENT = 'web/deepseek-search-llm-request'

/**
 * `work`, or a rejection with `signal`'s reason as soon as it aborts, whichever comes first; without a signal, `work` itself.
 * A value `work` yields after the abort is handed to `late` (to let it go), and a failure then is dropped.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined, late?: (value: T) => void): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('aborted', { cause: signal.reason })) }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      value => { signal.removeEventListener('abort', onAbort); if (signal.aborted) late?.(value); else resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/**
 * `value` as a plain JSON object: DSH refuses a tool value that does not survive JSON intact (an `undefined` property, a
 * `Date`, an object without the plain prototype), and checks it against the declared object schema.
 */
function jsonObject(value: unknown): Record<string, unknown> {
  const json: unknown = value === undefined ? null : JSON.parse(JSON.stringify(value))
  return json !== null && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : { result: json }
}

/** A tool of Outpost as DSH registers it: the arguments go to `execute` as the model sent them, the answer back as JSON text. */
function definitionOf(spec: ToolSpec): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: toolParameters(spec.schema),
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async args => jsonObject(await spec.execute(args)),
  }
}

function outcomeOf(reason: TurnEndReason, usage: Usage): SessionOutcome {
  switch (reason.kind) {
    case 'completed': case 'aborted': case 'blocked': case 'max-tokens': case 'interrupted':
      return { reason: reason.kind, usage }
    case 'error':
      return { reason: 'error', usage, error: reason.error.message }
    case 'forked': // only the seed of a forked session carries it; a live turn never ends so
      return { reason: 'interrupted', usage }
    default:
      return { reason: 'error', usage, error: `The turn ended in a way Outpost does not know: ${(reason as { kind: string }).kind}` }
  }
}

export class DshSessionDriver implements SessionDriver {
  /** The tools of each session, by id, until it is archived. */
  private readonly bound = new Map<string, ToolSpec[]>()
  /** The agent each session's tools are registered on now, and how to take them off again. */
  private readonly attached = new Map<string, { agent: Agent; specs: ToolSpec[]; dispose(): void }>()
  /** The research sessions this driver made and whose live agent it still holds, by id (see `release`). */
  private readonly owned = new Map<string, AgentHandle>()
  /** The 追问 chats it opened or gave their tools again: the user's conversations, which `release` never touches. */
  private readonly chats = new Set<string>()
  /** The agents already refused `UNSAFE_BROWSER_TOOL` (`refuseUnsafeBrowser`), so that none is guarded twice. */
  private readonly guarded = new WeakSet<Agent>()
  /** Who hears what the 追问 chats use (`onChatUsage`); none once Outpost stops (`close`). */
  private chatUsage: ((sessionId: string, usage: Usage) => void) | undefined
  /**
   * Why the last research session made was not on the browser preset, as logged (`noteBrowserProblem`), or null when it
   * was: the reason goes to DSH's log once each time it changes, not with every session of a day's run.
   */
  private browserProblem: string | null = null

  /**
   * @param ctx - the plugin's Context, which provides `sessionController`, `workspaceRegistry`, `sessionPersistence`,
   *   `agents`, `agentPresets` and `agentDefaultModel`. Research sessions it makes belong to it: they end with it.
   * @param workspaceDir - absolute directory of the 「前哨」 workspace; made when missing.
   */
  constructor(private readonly ctx: Context, private readonly workspaceDir: string) {
    // DSH makes a new agent for a session on every create, resume and compaction; each gets the session's tools, and each
    // on a research preset the guard (one DSH reopens included: Outpost did not make it, and its browser is back). A
    // failure here would fail the agent's creation, so it is only logged; `open` registers the tools again and reports it.
    // The guard goes on before the agent runs anything: DSH releases its queued work only after these listeners.
    ctx.on('agent/created', ({ agent }) => {
      try {
        if (isResearchAgent(agent)) this.refuseUnsafeBrowser(agent)
      } catch (error) {
        ctx.logger.warn('dsh-outpost: could not refuse %s to research session %s: %s', UNSAFE_BROWSER_TOOL, agent.id, String(error))
      }
      try { this.attach(agent) } catch (error) { ctx.logger.warn('dsh-outpost: could not register the tools of session %s: %s', agent.id, String(error)) }
      return undefined
    })
    // What a 追问 chat uses, as it goes: the user chats for as long as they like, long after Outpost opened the chat.
    ctx.on('session/event', (session, event) => {
      if (!this.chats.has(session.id) || !this.chatUsage) return
      let used: Usage | undefined
      if (event.type === 'assistant/message' && event.data.usage) { used = noUsage(); addUsage(used, event.data.usage) }
      else if ((event.type as string) === SEARCH_EVENT) used = { ...noUsage(), searches: 1 }
      if (!used) return
      try { this.chatUsage(session.id, used) } catch (error) { ctx.logger.warn('dsh-outpost: could not record what chat %s used: %s', session.id, String(error)) }
    })
  }

  /** Hears, from now on, each reply and each search of every 追问 chat (`SessionDriver.onChatUsage`). */
  onChatUsage(listener: (sessionId: string, usage: Usage) => void): void {
    this.chatUsage = listener
  }

  /**
   * The time limit (`signal`) covers making the session too: a creation that outlasts it (DSH waits for the preset's
   * Playwright MCP server, with no startup timeout of its own) is given up, the round reports `timeout`, and nothing of the
   * session is left bound or held (`open`).
   */
  async run(spec: SessionSpec, signal: AbortSignal): Promise<SessionOutcome> {
    if (signal.aborted) return { reason: 'timeout', usage: noUsage() }
    let agent: Agent
    try {
      agent = await this.open(spec, 'research', signal)
    } catch (error) {
      if (!signal.aborted) throw error
      this.ctx.logger.warn('dsh-outpost: session %s was still being made (its browser starting, say) when its time limit ran out or Outpost stopped; given up', spec.sessionId)
      return { reason: 'timeout', usage: noUsage() }
    }
    this.select(agent, spec)
    return this.round(agent, spec.prompt, signal)
  }

  async nudge(sessionId: string, text: string, signal: AbortSignal): Promise<SessionOutcome> {
    if (signal.aborted) return { reason: 'timeout', usage: noUsage() }
    const agent = await this.resolve(sessionId)
    if (!agent) throw new Error(`dsh-outpost: session "${sessionId}" does not exist`)
    this.attach(agent)
    return this.round(agent, text, signal)
  }

  async startInteractive(spec: SessionSpec): Promise<void> {
    const agent = await this.open(spec, 'followup')
    this.select(agent, spec)
    agent.followup(this.message(spec.prompt))
    await this.persist()
  }

  /**
   * Gives an existing session its tools again without saying anything to it: after DSH or Outpost restarts, a 追问 chat the
   * user reopens still has `outpost_read`. They are registered on the session's live agent now, if it has one (DSH's agent
   * registry; a stored session is not resumed for this), and on every agent DSH makes for it later (resume, compaction).
   * @throws When the id lacks the `outpost-` prefix, or DSH refuses a tool on the live agent.
   */
  rebind(sessionId: string, tools: ToolSpec[]): void {
    if (!sessionId.startsWith(SESSION_PREFIX)) throw new Error(`dsh-outpost: session id "${sessionId}" must start with "${SESSION_PREFIX}"`)
    this.bound.set(sessionId, tools)
    this.chats.add(sessionId)
    const live = this.ctx.get('agents')?.get(sessionId as SessionId)
    if (live) this.attach(live)
  }

  /**
   * Takes every tool it registered off the live agents and forgets every binding, so that no agent can call a tool of a
   * stopped Outpost (they answer from a closed store); a restarted Outpost binds them again.
   */
  close(): void {
    for (const { dispose } of this.attached.values()) {
      try { dispose() } catch { /* the agent is gone, and its tools with it */ }
    }
    this.attached.clear()
    this.bound.clear()
    this.chatUsage = undefined // a chat the user goes on with after Outpost stopped is not charged to a closed store
  }

  /**
   * Ends the live agent of a research session this driver made (`createOwned`) by disposing its handle: DSH stops the
   * agent, unregisters it and unwinds its scope, and the browser provider closes the Playwright MCP server and the Chrome
   * it launched for the session (docs/subsystems/browser-use.md, 「Session 所有权」). The session log stays on disk and in
   * the 「前哨」 workspace: opening it in DSH later resumes it, without Outpost's tools. A 追问 chat is the user's and is
   * left alone. A research session DSH resumed (after a restart) is held by DSH, which offers no way to let it go
   * (archiving does not end the live agent): it only loses its tools, and the log says its browser stays.
   */
  async release(sessionId: string): Promise<void> {
    try {
      if (this.chats.has(sessionId)) return
      const handle = this.owned.get(sessionId)
      this.owned.delete(sessionId)
      if (!handle && this.bound.has(sessionId) && this.ctx.get('agents')?.get(sessionId as SessionId)) {
        this.ctx.logger.warn('dsh-outpost: session %s was opened by DSH, not by Outpost; its live agent (and its browser) stays until DSH restarts', sessionId)
      }
      try {
        this.forget(sessionId)
      } finally {
        await handle?.dispose() // the agent goes even when taking its tools back failed
      }
    } catch (error) {
      this.ctx.logger.warn('dsh-outpost: could not end the live agent of session %s: %s', sessionId, error instanceof Error ? error.message : String(error))
    }
  }

  async archive(sessionId: string): Promise<void> {
    await this.ctx.workspaceRegistry.archiveSession(sessionId as SessionId, { stopActivity: true })
    this.forget(sessionId)
    await this.release(sessionId)
  }

  /** Takes the session's tools off its agent and forgets them, so that an agent DSH makes for it later gets none. */
  private forget(sessionId: string): void {
    this.bound.delete(sessionId)
    this.attached.get(sessionId)?.dispose()
    this.attached.delete(sessionId)
  }

  /**
   * The live agent of the session, created (and titled) first when it does not exist; its tools registered. A research
   * session is made by this driver (`createOwned`) on the research preset usable now (`chooseResearchPreset`); a 追问 chat by
   * DSH's session controller, on `FOLLOWUP_PRESET`. A session that exists keeps the preset it was made on.
   *
   * `signal` (a research run's time limit) bounds the waits of making a research session: finding it, choosing its preset,
   * and DSH creating its agent. When it aborts first, or the research session cannot be made, the session's tools are taken
   * back before this throws, so that no agent made for it later (a creation finishing late, the user opening it) gets them.
   */
  private async open(spec: Pick<SessionSpec, 'sessionId' | 'title' | 'tools'>, kind: 'research' | 'followup', signal?: AbortSignal): Promise<Agent> {
    const id = spec.sessionId
    if (!id.startsWith(SESSION_PREFIX)) throw new Error(`dsh-outpost: session id "${id}" must start with "${SESSION_PREFIX}"`)
    const research = kind === 'research'
    // Bound before the agent exists, so that `agent/created` finds the tools.
    this.bound.set(id, spec.tools)
    if (!research) this.chats.add(id)
    let agent: Agent | undefined
    try {
      agent = await abortable(this.resolve(id), signal)
      if (!agent) {
        // Chosen before anything is written: a preset that cannot compose would fail every research session, each after
        // DSH had already written an empty one.
        let preset = FOLLOWUP_PRESET
        if (research) {
          const choice = await abortable(chooseResearchPreset(this.ctx), signal)
          if (choice.preset === null) {
            this.ctx.logger.warn('dsh-outpost: no research preset can compose a session: %s', choice.problem)
            throw new Error(RESEARCH_PRESET_BROKEN)
          }
          this.noteBrowserProblem(choice.browserProblem)
          preset = choice.preset
        }
        await mkdir(this.workspaceDir, { recursive: true }) // DSH makes a workspace only of an existing directory
        const workspace = await this.ctx.workspaceRegistry.create(this.workspaceDir, WORKSPACE_TITLE)
        if (research) {
          agent = await this.createOwned(id, workspace, preset, signal)
        } else {
          const created = await this.ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id, agentPreset: preset })
          if (created.sessionId !== id) throw new Error(`dsh-outpost: DSH created session "${created.sessionId}" instead of "${id}"`)
          agent = await this.resolve(id)
          if (!agent) throw new Error(`dsh-outpost: session "${id}" vanished right after it was created`)
        }
        await this.ctx.sessionController.rename({ sessionId: id as SessionId, title: spec.title })
      }
    } catch (error) {
      // A research session that was never made (or that this driver does not hold) has no run left to serve.
      if (research && !this.owned.has(id)) this.abandon(id)
      throw error
    }
    this.attach(agent)
    return agent
  }

  /**
   * Logs why research sessions run without the browser preset (`problem`, from `chooseResearchPreset`) when the reason is
   * new: once per reason, not once per session; a session on the browser preset clears it, so that a reason coming back
   * later is logged again. 设置 says the same to the user (`browserMissing`).
   */
  private noteBrowserProblem(problem: string | null): void {
    if (problem !== null && problem !== this.browserProblem) {
      this.ctx.logger.warn('dsh-outpost: research sessions run on %s, without Outpost\'s own browser, because %s cannot be used: %s', BASIC_AGENT_PRESET, AGENT_PRESET, problem)
    }
    this.browserProblem = problem
  }

  /** Takes back the tools bound for a session whose making failed or was given up, even from an agent that is gone. */
  private abandon(sessionId: string): void {
    try { this.forget(sessionId) } catch { /* the agent is gone, and its tools with it */ }
  }

  /**
   * A new research session on `preset` (one of `RESEARCH_PRESETS`) whose live agent this driver holds. It is made as DSH's
   * session controller makes one (the preset mounted during setup and named in the session's header, the workspace's
   * directory as its cwd, DSH's default model read anew until the spec selects one, the session put into the workspace),
   * but through `ctx.agents.create`, which hands the caller the agent's handle: disposing it is the one way DSH has to end
   * a session's live agent without archiving it. The session controller's own create keeps that handle until DSH stops, and
   * with it the browser the preset launched.
   *
   * During setup the agent is refused `UNSAFE_BROWSER_TOOL` (`refuseUnsafeBrowser`; its announcement then adds nothing).
   * `signal` is DSH's creation-only cancel (`CreateAgentOptions.signal`): DSH
   * rolls the creation back when it aborts. Should a creation finish all the same after the abort, its handle is disposed
   * at once.
   */
  private async createOwned(id: string, workspace: Workspace, preset: string, signal?: AbortSignal): Promise<Agent> {
    const presets = this.ctx.get('agentPresets') as AgentPresets | undefined
    if (!presets) throw new Error(`dsh-outpost: DSH has no agent presets here, so the research preset "${preset}" cannot compose a session`)
    const defaults = this.ctx.agentDefaultModel
    const agentOptions: AgentOptions = {
      get provider() { return defaults.currentSelection().provider },
      get model() { return defaults.currentSelection().model },
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
    }
    const creation = this.ctx.agents.create({
      sessionId: id as SessionId,
      agentOptions,
      meta: { cwd: workspace.path, agentPreset: preset },
      ...signal ? { signal } : {},
      setup: async (agentCtx, agent) => {
        this.refuseUnsafeBrowser(agent)
        await presets.mount(agentCtx, preset)
      },
    })
    const handle = await abortable(creation, signal, late => {
      this.abandon(id)
      late.dispose().catch((error: unknown) => {
        this.ctx.logger.warn('dsh-outpost: could not end session %s, made after its run gave up on it: %s', id, error instanceof Error ? error.message : String(error))
      })
    })
    this.owned.set(id, handle)
    await workspace.attachSession(id as SessionId)
    return handle.agent
  }

  /**
   * Refuses `agent` the browser tool that runs arbitrary code, once per agent: a guard on the agent's own scope, which DSH
   * checks for every call the agent makes, after approval (`tools.guard`), and which goes with the agent. Every other
   * tool, the other browser tools included, is left as it is.
   */
  private refuseUnsafeBrowser(agent: Agent): void {
    if (this.guarded.has(agent)) return
    agent.ctx.tools.guard(exec => exec.name === UNSAFE_BROWSER_TOOL ? RESEARCH_TOOL_REFUSED : undefined)
    this.guarded.add(agent)
  }

  /** The live agent of a session (resumed when it is stored but not loaded), or undefined when there is no such session. */
  private async resolve(sessionId: string): Promise<Agent | undefined> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if (!('error' in result)) return result.agent
    if (result.error.code === 'session/not-found') return undefined
    throw result.error
  }

  /** Puts the session on the spec's model, before it is told anything; with none (null), DSH's choice stands. */
  private select(agent: Agent, spec: Pick<SessionSpec, 'model'>): void {
    if (spec.model) agent.model.select({ provider: spec.model.provider, model: spec.model.model })
  }

  /** Registers the session's tools on `agent`, replacing those of an earlier round; a session without tools is left alone. */
  private attach(agent: Agent): void {
    const specs = agent.id.startsWith(SESSION_PREFIX) ? this.bound.get(agent.id) : undefined
    if (!specs) return
    const current = this.attached.get(agent.id)
    // A new agent of the session starts without them; the old one's registrations went with its scope.
    if (current?.agent === agent) {
      if (current.specs === specs) return
      current.dispose()
    }
    this.attached.delete(agent.id)
    const disposers: (() => void)[] = []
    const dispose = () => { for (const off of disposers.splice(0)) off() }
    try {
      for (const spec of specs) disposers.push(agent.ctx.tools.register(definitionOf(spec)))
    } catch (error) {
      dispose()
      throw error
    }
    this.attached.set(agent.id, { agent, specs, dispose })
  }

  private message(text: string): UserMessage {
    return { id: `outpost:${randomUUID()}` as MessageId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-outpost', form: 'relay' } }
  }

  /** Makes the message durable. The agent has it either way, so a failure here is logged, not thrown. */
  private async persist(): Promise<void> {
    try { await this.ctx.sessionPersistence.flush() }
    catch (error) { this.ctx.logger.warn('dsh-outpost: could not flush the session log: %s', String(error)) }
  }

  /**
   * Sends `text` and waits for the end of the turn that takes it, summing the usage of that turn. Turns that end before it
   * (one the user started, say) and events of other sessions do not count. When `signal` aborts first, the turn is
   * cancelled and the round reports `timeout` with the usage so far.
   *
   * The turn is known when DSH claims the message (`agent/inbox/claimed`). It records the message (`user/message`) only
   * after checking the model, tools, system prompt, pre-step hooks and request, and a turn that fails or is blocked there
   * ends with no `user/message` (agent-loop `preStep`); matching on the record alone would wait for the time limit and
   * lose the error. The record still marks the turn should a claim go unannounced. A round that ends on `signal` without
   * ever having seen either is logged as a warning naming the session: DSH's events no longer say which turn took the
   * message (an adapter mismatch), and every round would otherwise end only at its time limit, silently.
   */
  private async round(agent: Agent, text: string, signal: AbortSignal): Promise<SessionOutcome> {
    const usage = noUsage()
    if (signal.aborted) return { reason: 'timeout', usage }
    const sessionId = agent.id
    const message = this.message(text)
    const { promise, resolve } = Promise.withResolvers<SessionOutcome>()
    /** The latest turn to start; the one that took the message, once it has (DSH opens a turn before it takes messages). */
    let latest: number | undefined
    let mine: number | undefined
    const unclaimed = this.ctx.on('agent/inbox/claimed', ({ agent: owner, message: claimed, turn }) => {
      if (owner.id === sessionId && claimed.id === message.id) mine ??= turn
    })
    const unevented = this.ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId) return
      if (event.type === 'turn/start') latest = event.data.turn
      else if (event.type === 'user/message') { if (event.data.id === message.id) mine ??= latest }
      else if (mine === undefined) return
      else if (event.type === 'assistant/message') { if (event.data.turn === mine) addUsage(usage, event.data.usage) }
      else if ((event.type as string) === SEARCH_EVENT) usage.searches = (usage.searches ?? 0) + 1
      else if (event.type === 'turn/end' && event.data.turn === mine) settle(outcomeOf(event.data.reason, { ...usage }))
    })
    const stop = () => { unclaimed(); unevented() }
    const onAbort = () => {
      if (mine === undefined) {
        this.ctx.logger.warn('dsh-outpost: session %s ended its round (time limit or stop) without seeing which turn took its message: no agent/inbox/claimed and no user/message for it. If this repeats, DSH\'s session events may have changed.', sessionId)
      }
      try { this.ctx.sessionController.cancel({ sessionId }) } catch { /* no live agent: nothing runs to stop */ }
      settle({ reason: 'timeout', usage: { ...usage } })
    }
    const settle = (outcome: SessionOutcome) => {
      stop()
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      agent.followup(message)
    } catch (error) {
      stop()
      signal.removeEventListener('abort', onAbort)
      throw error
    }
    await this.persist()
    return promise
  }
}
