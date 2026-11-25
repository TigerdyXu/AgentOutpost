/**
 * `SessionDriver` on DSH: Outpost's research sessions are ordinary DSH sessions in the 「前哨」 workspace, running the
 * `outpost-researcher` preset. Each gets the `outpost_*` tools of its round on its own agent, and is told what to do with a
 * message of Outpost's own (`source.kind: 'dsh-outpost'`), never one posing as the user. A round ends with the end of the
 * turn that took its message; what it cost is the usage of that turn's assistant messages.
 *
 * Every DSH value comes through `ctx` (session controller, workspace registry, persistence, agents); this file imports only
 * DSH types.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { MessageId, TokenUsage, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
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
/** Title of the DSH workspace the sessions live in. */
export const WORKSPACE_TITLE = '前哨'

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

  /**
   * @param ctx - the plugin's Context, which provides `sessionController`, `workspaceRegistry` and `sessionPersistence`.
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
    if (spec.model) agent.model.select({ provider: spec.model.provider, model: spec.model.model })
    return this.round(agent, spec.prompt, signal)
  }

  async nudge(sessionId: string, text: string, signal: AbortSignal): Promise<SessionOutcome> {
    if (signal.aborted) return { reason: 'timeout', usage: noUsage() }
    const agent = await this.resolve(sessionId)
    if (!agent) throw new Error(`dsh-outpost: session "${sessionId}" does not exist`)
    this.attach(agent)
    return this.round(agent, text, signal)
  }

  async startInteractive(spec: Omit<SessionSpec, 'model'>): Promise<void> {
    const agent = await this.open(spec)
    agent.followup(this.message(spec.prompt))
    await this.persist()
  }

  async archive(sessionId: string): Promise<void> {
    await this.ctx.workspaceRegistry.archiveSession(sessionId as SessionId, { stopActivity: true })
    this.bound.delete(sessionId)
    this.attached.get(sessionId)?.dispose()
    this.attached.delete(sessionId)
  }

  /** The live agent of the session, created (and titled) first when it does not exist; its tools registered. */
  private async open(spec: Pick<SessionSpec, 'sessionId' | 'title' | 'tools'>): Promise<Agent> {
    const id = spec.sessionId
    if (!id.startsWith(SESSION_PREFIX)) throw new Error(`dsh-outpost: session id "${id}" must start with "${SESSION_PREFIX}"`)
    // Bound before the agent exists, so that `agent/created` finds the tools.
    this.bound.set(id, spec.tools)
    let agent = await this.resolve(id)
    if (!agent) {
      await mkdir(this.workspaceDir, { recursive: true }) // DSH makes a workspace only of an existing directory
      const workspace = await this.ctx.workspaceRegistry.create(this.workspaceDir, WORKSPACE_TITLE)
      const created = await this.ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id, agentPreset: AGENT_PRESET })
      if (created.sessionId !== id) throw new Error(`dsh-outpost: DSH created session "${created.sessionId}" instead of "${id}"`)
      agent = await this.resolve(id)
      if (!agent) throw new Error(`dsh-outpost: session "${id}" vanished right after it was created`)
      await this.ctx.sessionController.rename({ sessionId: id as SessionId, title: spec.title })
    }
    this.attach(agent)
    return agent
  }

  /** The live agent of a session (resumed when it is stored but not loaded), or undefined when there is no such session. */
  private async resolve(sessionId: string): Promise<Agent | undefined> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if (!('error' in result)) return result.agent
    if (result.error.code === 'session/not-found') return undefined
    throw result.error
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
    const stop = this.ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId) return
      if (event.type === 'turn/start') latest = event.data.turn
      else if (event.type === 'user/message') { if (event.data.id === message.id) mine = latest }
      else if (mine === undefined) return
      else if (event.type === 'assistant/message') { if (event.data.turn === mine) addUsage(usage, event.data.usage) }
      else if (event.type === 'turn/end' && event.data.turn === mine) settle(outcomeOf(event.data.reason, { ...usage }))
    })
    const onAbort = () => {
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
