/**
 * `SessionDriver` on DSH: Outpost's research sessions are ordinary DSH sessions in the 「前哨」 workspace, running the
 * `outpost-researcher` preset (a 追问 chat runs DSH's `standard` preset instead: it is the user's own conversation, design
 * §7.7). Each gets the `outpost_*` tools of its round on its own agent, and is told what to do with a
 * message of Outpost's own (`source.kind: 'dsh-outpost'`), never one posing as the user. A round ends with the end of the
 * turn that took its message; what it cost is the usage of that turn's assistant messages.
 *
 * Outpost makes a research session's agent itself (`ctx.agents.create`) and keeps its handle, so that `release` can end
 * the live agent once the run is over: that closes the browser the preset launched for it. A 追问 chat is made by DSH's
 * session controller, as any chat of the user's, and stays.
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

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A message Outpost sends into one of its sessions: a research brief, a nudge, or the question of a follow-up chat. */
    'dsh-outpost': { readonly kind: 'dsh-outpost'; readonly form: 'relay' }
  }
}

/** Every Outpost session id starts with this; the tools go only to sessions that carry it. */
export const SESSION_PREFIX = 'outpost-'
export const AGENT_PRESET = 'outpost-researcher'
/**
 * The preset of a 追问 chat: DSH's own `standard` agent (`packages/bundle/web-app/presets/standard.patch.yml` in the dsh
 * source), which the desktop and web profiles compose, with `outpost_read` added.
 */
export const FOLLOWUP_PRESET = 'standard'
/** Title of the DSH workspace the sessions live in. */
export const WORKSPACE_TITLE = '前哨'

/**
 * What Outpost uses of DSH's preset registry (`ctx.agentPresets`, package `@deepseek-ai/dsh-agent-preset-registry`):
 * composing a new agent from a preset during its setup, and reading which modules each preset revision has running.
 */
export interface AgentPresets {
  mount(agentCtx: Context, id: string): Promise<{ id: string }>
  inspectCompositions(): readonly { readonly id: string; readonly modules: readonly { readonly moduleName: string }[] }[]
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

  /**
   * @param ctx - the plugin's Context, which provides `sessionController`, `workspaceRegistry`, `sessionPersistence`,
   *   `agents`, `agentPresets` and `agentDefaultModel`. Research sessions it makes belong to it: they end with it.
   * @param workspaceDir - absolute directory of the 「前哨」 workspace; made when missing.
   */
  constructor(private readonly ctx: Context, private readonly workspaceDir: string) {
    // DSH makes a new agent for a session on every create, resume and compaction; each gets the session's tools. A failure
    // here would fail the agent's creation, so it is only logged; `open` registers again and reports it.
    ctx.on('agent/created', ({ agent }) => {
      try { this.attach(agent) } catch (error) { ctx.logger.warn('dsh-outpost: could not register the tools of session %s: %s', agent.id, String(error)) }
      return undefined
    })
  }

  async run(spec: SessionSpec, signal: AbortSignal): Promise<SessionOutcome> {
    if (signal.aborted) return { reason: 'timeout', usage: noUsage() }
    const agent = await this.open(spec)
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
    const agent = await this.open(spec, FOLLOWUP_PRESET)
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
    if (this.chats.has(sessionId)) return
    const handle = this.owned.get(sessionId)
    this.owned.delete(sessionId)
    if (!handle && this.bound.has(sessionId) && this.ctx.get('agents')?.get(sessionId as SessionId)) {
      this.ctx.logger.warn('dsh-outpost: session %s was opened by DSH, not by Outpost; its live agent (and its browser) stays until DSH restarts', sessionId)
    }
    this.forget(sessionId)
    try {
      await handle?.dispose()
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
   * The live agent of the session, created (and titled) first, on `preset`, when it does not exist; its tools registered.
   * A research session is made by this driver (`createOwned`), a 追问 chat by DSH's session controller.
   */
  private async open(spec: Pick<SessionSpec, 'sessionId' | 'title' | 'tools'>, preset = AGENT_PRESET): Promise<Agent> {
    const id = spec.sessionId
    if (!id.startsWith(SESSION_PREFIX)) throw new Error(`dsh-outpost: session id "${id}" must start with "${SESSION_PREFIX}"`)
    // Bound before the agent exists, so that `agent/created` finds the tools.
    this.bound.set(id, spec.tools)
    if (preset !== AGENT_PRESET) this.chats.add(id)
    let agent = await this.resolve(id)
    if (!agent) {
      await mkdir(this.workspaceDir, { recursive: true }) // DSH makes a workspace only of an existing directory
      const workspace = await this.ctx.workspaceRegistry.create(this.workspaceDir, WORKSPACE_TITLE)
      if (preset === AGENT_PRESET) {
        agent = await this.createOwned(id, workspace)
      } else {
        const created = await this.ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id, agentPreset: preset })
        if (created.sessionId !== id) throw new Error(`dsh-outpost: DSH created session "${created.sessionId}" instead of "${id}"`)
        agent = await this.resolve(id)
        if (!agent) throw new Error(`dsh-outpost: session "${id}" vanished right after it was created`)
      }
      await this.ctx.sessionController.rename({ sessionId: id as SessionId, title: spec.title })
    }
    this.attach(agent)
    return agent
  }

  /**
   * A new research session whose live agent this driver holds. It is made as DSH's session controller makes one (the
   * preset mounted during setup, the workspace's directory as its cwd, DSH's default model read anew until the spec
   * selects one, the session put into the workspace), but through `ctx.agents.create`, which hands the caller the
   * agent's handle: disposing it is the one way DSH has to end a session's live agent without archiving it. The session
   * controller's own create keeps that handle until DSH stops, and with it the browser the preset launched.
   */
  private async createOwned(id: string, workspace: Workspace): Promise<Agent> {
    const presets = this.ctx.get('agentPresets') as AgentPresets | undefined
    if (!presets) throw new Error(`dsh-outpost: DSH has no agent presets here, so the research preset "${AGENT_PRESET}" cannot compose a session`)
    const defaults = this.ctx.agentDefaultModel
    const agentOptions: AgentOptions = {
      get provider() { return defaults.currentSelection().provider },
      get model() { return defaults.currentSelection().model },
      get reasoningEffort() { return defaults.currentSelection().reasoningEffort },
    }
    const handle = await this.ctx.agents.create({
      sessionId: id as SessionId,
      agentOptions,
      meta: { cwd: workspace.path, agentPreset: AGENT_PRESET },
      setup: async agentCtx => { await presets.mount(agentCtx, AGENT_PRESET) },
    })
    this.owned.set(id, handle)
    await workspace.attachSession(id as SessionId)
    return handle.agent
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
