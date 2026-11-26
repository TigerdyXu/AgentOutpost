/**
 * An in-memory stand-in for the parts of DSH the adapters use (as superagent's `tests/fixtures/host.ts` builds one): a Cordis
 * `Context` providing `sessionController`, `workspaceRegistry`, `sessionPersistence`, `llm`, `agentDefaultModel`, `agentPresets`
 * and `agents`, and fake agents with their own `agent.ctx.tools`. Like DSH, creating or resuming a session runs the creator's
 * setup and then emits `agent/created` before it resolves; an agent made with `agents.create` belongs to its caller, whose
 * handle's `dispose` takes the live agent (and everything registered on it) away while the session stays stored;
 * the creator's setup may install tool guards on the agent's scope (`agentCtx.tools.guard`), which DSH checks for every call the
 * agent makes; a creation can be made to stall where DSH starts the browser (`stallCreation`), and, like DSH, it gives up on
 * the caller's `signal` and rolls back (it also fails a creation whose signal aborted by the time setup is over);
 * a message sent to an idle agent starts a turn at once (`turn/start`; the step takes the message out of the inbox,
 * `agent/inbox/claimed`; then records it, `user/message`), and one sent while a turn runs waits for that turn to end. The test plays the model: `assistant(...)` and `turnEnd(...)` emit what
 * DSH would.
 */
import { Context } from '@deepseek-ai/cordis'
import { vi, type Mock } from 'vitest'

/** A tool as `agent.ctx.tools.register` receives it. */
export interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render(args: unknown, value: unknown): { type: string; text?: string }[] }
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

export interface SentMessage { id: string; role: string; content: { type: string; text: string }[]; source: { kind: string; form?: string } }

/** What DSH keeps in a session's durable header that the adapters read: the preset its agent was composed from. */
export interface SessionHeader { agentPreset?: string }

export interface FakeAgent {
  id: string
  ctx: Context
  /** The live session, with its durable header (restored as it was stored when DSH resumes it). */
  session: { id: string; header: SessionHeader }
  model: { select: Mock<(selection: { provider: string; model: string }) => void> }
  followup: Mock<(message: SentMessage) => void>
  /** Number of the latest turn, 0 before the first. */
  turn: number
  /** Whether the latest turn has not ended yet. */
  running: boolean
  /** Messages waiting for the next turn. */
  queued: SentMessage[]
}

/** What `agents.create` is given, as DSH's `CreateAgentOptions` has it. */
export interface CreateOptions {
  sessionId: string
  agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
  meta?: { cwd?: string; agentPreset?: string }
  /** DSH's creation-only cancel: an abort before the handle is returned rolls the creation back. */
  signal?: AbortSignal
  setup?: (agentCtx: Context, agent: FakeAgent) => unknown
}

/** A tool guard as `agentCtx.tools.guard` takes it (`ToolGuard` in `@deepseek-ai/dsh-tools`): a reason denies the call. */
export type Guard = (exec: { name: string; arguments: unknown }) => string | { reason: string } | undefined

/** A creation held where DSH starts the session's browser (`agent/created`, before any other listener). */
interface Stall { held: true }

/** A model chunk, as `ctx.llm.stream` yields them. */
export type Chunk = Record<string, unknown> & { type: string }

export function dshHost() {
  const ctx = new Context()
  const agents = new Map<string, FakeAgent>()
  /** Sessions stored on disk, live or not. */
  const stored = new Set<string>()
  /** The durable header of each session, by id: written when the session is made, read back on every resume. */
  const headers = new Map<string, SessionHeader>()
  const tools = new Map<string, Map<string, RegisteredTool>>()
  /** The guards installed on each session's current agent. */
  const guards = new Map<string, Guard[]>()
  /** Creations to hold, oldest first: the next `agents.create` takes the first. */
  const stalls: Stall[] = []
  const sent = new Map<string, SentMessage[]>()
  /** Sessions whose next turns take their message and then fail before recording it (no `user/message`). */
  const unrecorded = new Set<string>()
  /** Whether claims are announced with `agent/inbox/claimed`. */
  let claimEvents = true

  const emit = (sessionId: string, type: string, data: unknown) => {
    const agent = agents.get(sessionId)
    ctx.emit('session/event', (agent?.session ?? { id: sessionId }) as never, { type, seq: 0, time: Date.now(), data } as never)
  }
  /**
   * The next turn starts, and its first step claims the oldest waiting message and (unless the step fails before, as a
   * wrong model or a rejecting pre-step hook makes it in DSH) records it in the history.
   */
  const next = (agent: FakeAgent) => {
    const message = agent.queued.shift()
    if (!message) { agent.running = false; return }
    agent.turn++
    agent.running = true
    emit(agent.id, 'turn/start', { turn: agent.turn })
    if (claimEvents) ctx.emit('agent/inbox/claimed', { agent, message, turn: agent.turn } as never)
    if (!unrecorded.has(agent.id)) emit(agent.id, 'user/message', message)
  }

  /** A new agent instance for `sessionId` (a fresh one on every create or resume, as DSH does), announced with `agent/created`. */
  const spawn = async (sessionId: string, kind: 'new' | 'resume', setup?: (agentCtx: Context, agent: FakeAgent) => unknown, creation?: { signal?: AbortSignal; stall?: Stall }) => {
    const agentCtx = new Context()
    const own = new Map<string, RegisteredTool>()
    const guarded: Guard[] = []
    tools.set(sessionId, own)
    guards.set(sessionId, guarded)
    agentCtx.reflect.provide('tools', {
      register: vi.fn((tool: RegisteredTool) => {
        if (own.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
        own.set(tool.name, tool)
        return () => { if (own.get(tool.name) === tool) own.delete(tool.name) }
      }),
      guard: vi.fn((guard: Guard) => {
        guarded.push(guard)
        return () => { const at = guarded.indexOf(guard); if (at >= 0) guarded.splice(at, 1) }
      }),
    })
    const agent: FakeAgent = {
      id: sessionId, ctx: agentCtx, session: { id: sessionId, header: headers.get(sessionId) ?? {} }, turn: 0, running: false, queued: [],
      model: { select: vi.fn() },
      // A message wakes an idle agent; one that arrives while a turn runs waits for the next turn.
      followup: vi.fn((message: SentMessage) => {
        sent.set(sessionId, [...sent.get(sessionId) ?? [], message])
        agent.queued.push(message)
        if (!agent.running) { agent.running = true; queueMicrotask(() => { next(agent) }) }
      }),
    }
    const wasStored = stored.has(sessionId)
    agents.set(sessionId, agent)
    stored.add(sessionId)
    try {
      await setup?.(agentCtx, agent)
      // DSH's browser provider listens first on `agent/created` and waits there for its Playwright MCP server to start,
      // giving up only on the creation's signal (it has no startup timeout).
      if (creation?.stall) await held(creation.signal)
      creation?.signal?.throwIfAborted() // as DSH checks after setup and after the announcement (`assertLive`)
      await ctx.serial('agent/created', { agent, source: { kind: kind === 'new' ? 'startup' : 'resume' } } as never)
    } catch (error) {
      // As in DSH, a listener that throws, or the creation's signal, fails the creation: the agent is gone again, and what
      // was registered on its scope with it.
      agents.delete(sessionId)
      own.clear()
      guarded.splice(0)
      if (!wasStored) stored.delete(sessionId)
      throw error
    }
    return agent
  }
  /** Never resolves; rejects when `signal` aborts, as DSH's browser provider gives up its wait (`SessionResources.get`). */
  const held = (signal: AbortSignal | undefined) => new Promise<void>((_resolve, reject) => {
    if (!signal) return
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })

  const sessionController = {
    resolveAgent: vi.fn(async (sessionId: string) => {
      const live = agents.get(sessionId)
      if (live) return { agent: live }
      if (stored.has(sessionId)) return { agent: await spawn(sessionId, 'resume') }
      return { error: Object.assign(new Error(`session "${sessionId}" not found`), { code: 'session/not-found' }) }
    }),
    create: vi.fn(async (request: { sessionId: string; workspaceId: string; agentPreset?: string }) => {
      headers.set(request.sessionId, request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset })
      await spawn(request.sessionId, 'new')
      return { sessionId: request.sessionId, agentPreset: request.agentPreset }
    }),
    rename: vi.fn(async (request: { sessionId: string; title: string }) => ({ title: request.title, seq: 1 })),
    cancel: vi.fn((request: { sessionId: string }) => {
      if (!agents.has(request.sessionId)) throw Object.assign(new Error('not attached'), { code: 'session/not-found' })
      return { accepted: true }
    }),
  }
  /** The 「前哨」 workspace and others, by path; `attachSession` records the sessions put into each. */
  const workspaces = new Map<string, { id: string; path: string; attachSession: Mock<(sessionId: string) => Promise<void>> }>()
  const workspaceRegistry = {
    create: vi.fn(async (path: string, _title?: string) => {
      let workspace = workspaces.get(path)
      if (!workspace) workspaces.set(path, workspace = { id: `ws-${path}`, path, attachSession: vi.fn(async (_sessionId: string) => {}) })
      return workspace
    }),
    archiveSession: vi.fn(async (_sessionId: string, _options?: { stopActivity?: boolean }) => {}),
  }
  const sessionPersistence = { flush: vi.fn(async () => {}) }
  /** What the next `llm.stream` call yields. */
  let chunks: Chunk[] = []
  const llm = {
    stream: vi.fn((_options: Record<string, unknown>) => (async function* () { for (const chunk of chunks) yield chunk })()),
  }
  const agentDefaultModel = { currentSelection: vi.fn(() => ({ provider: 'deepseek-account', model: 'deepseek-flash' })) }

  /** What `agents.create` was asked for, in order; each carries the handle it answered with. */
  const created: { options: CreateOptions; handle: { agent: FakeAgent; dispose: Mock<() => Promise<void>> } }[] = []
  /** DSH's registry of live agents (`ctx.agents`): only those created or resumed, never stored ones. */
  const agentRegistry = {
    get: vi.fn((sessionId: string) => agents.get(sessionId)),
    /** Makes a new session and its agent for the caller, who owns it: disposing the handle ends the live agent. */
    create: vi.fn(async (options: CreateOptions) => {
      options.signal?.throwIfAborted()
      headers.set(options.sessionId, options.meta?.agentPreset === undefined ? {} : { agentPreset: options.meta.agentPreset })
      const agent = await spawn(options.sessionId, 'new', options.setup, { signal: options.signal, stall: stalls.shift() })
      const dispose = vi.fn(async () => {
        if (agents.get(agent.id) !== agent) return
        agents.delete(agent.id)
        tools.get(agent.id)?.clear() // what was registered on the agent goes with its scope
        guards.get(agent.id)?.splice(0)
      })
      const handle = { agent, dispose }
      created.push({ options, handle })
      return handle
    }),
  }
  /**
   * DSH's preset registry: `resolve` says whether a preset can compose a session (`broken` when not), `mount` composes an
   * agent from it during its setup.
   */
  const agentPresets = {
    resolve: vi.fn(async (id: string): Promise<{ id: string; broken?: string }> => ({ id })),
    mount: vi.fn(async (_agentCtx: Context, id: string) => ({ id })),
    inspectCompositions: vi.fn((): { id: string; modules: { moduleName: string; useHostBase: boolean }[]; leakedServices: string[] }[] => []),
  }

  for (const [name, service] of Object.entries({ sessionController, workspaceRegistry, sessionPersistence, llm, agentDefaultModel, agentPresets, agents: agentRegistry }))
    ctx.reflect.provide(name, service)

  const agentOf = (sessionId: string): FakeAgent => {
    const agent = agents.get(sessionId)
    if (!agent) throw new Error(`no agent for ${sessionId}`)
    return agent
  }

  return {
    ctx, sessionController, workspaceRegistry, sessionPersistence, llm, agentDefaultModel, agentPresets, agents: agentRegistry,
    agent: agentOf,
    /** Every `agents.create` call with the handle it answered with, oldest first. */
    created,
    /** The workspace at `path`, once `workspaceRegistry.create` made it. */
    workspace: (path: string) => workspaces.get(path),
    /** The tools registered on the session's current agent, by name. */
    tools: (sessionId: string) => tools.get(sessionId) ?? new Map<string, RegisteredTool>(),
    /** The guards installed on the session's current agent. */
    guards: (sessionId: string) => [...guards.get(sessionId) ?? []],
    /**
     * What DSH's guard check (`checkGuards`, after approval) says of a call of `name` by the session's current agent: the
     * first denial, as `{ reason }`, or undefined when no guard denies it.
     */
    denial: (sessionId: string, name: string, args: unknown = {}) => {
      for (const guard of guards.get(sessionId) ?? []) {
        const denied = guard({ name, arguments: args })
        if (denied !== undefined) return typeof denied === 'string' ? { reason: denied } : denied
      }
      return undefined
    },
    /**
     * Holds the next `agents.create` where DSH starts the session's browser, as a Playwright MCP server that never comes up;
     * it gives up when the creation's signal aborts and rolls the creation back, as DSH does.
     */
    stallCreation: () => { stalls.push({ held: true }) },
    /** The messages sent to the session, oldest first. */
    sent: (sessionId: string) => sent.get(sessionId) ?? [],
    /** A session that exists on disk with no live agent, as after a restart of DSH; `header` as it was written. */
    store: (sessionId: string, header: SessionHeader = {}) => { stored.add(sessionId); headers.set(sessionId, header) },
    /** Another agent (not Outpost's) being created, such as a chat the user opens; `header` names its preset, if any. */
    spawn: (sessionId: string, header?: SessionHeader) => { if (header) headers.set(sessionId, header); return spawn(sessionId, 'new') },
    /** Waits until the session's `count`-th turn has started. */
    started: (sessionId: string, count = 1) => vi.waitFor(() => { if ((agents.get(sessionId)?.turn ?? 0) < count) throw new Error(`turn ${count} of ${sessionId} has not started`) }),
    /** One step's assistant message, with its token accounting; in the latest turn unless told otherwise. */
    assistant: (sessionId: string, usage: Record<string, number> | undefined, turn = agentOf(sessionId).turn) =>
      emit(sessionId, 'assistant/message', { turn, step: 1, message: { role: 'assistant', content: [] }, stream: [], ...usage ? { usage } : {} }),
    /** The end of a turn; the latest one unless told otherwise. The end of the latest turn starts the next waiting one. */
    turnEnd: (sessionId: string, reason: Record<string, unknown> & { kind: string }, turn = agentOf(sessionId).turn) => {
      emit(sessionId, 'turn/end', { turn, reason })
      const agent = agents.get(sessionId)
      if (agent && turn === agent.turn) { agent.running = false; if (agent.queued.length) { agent.running = true; queueMicrotask(() => { next(agent) }) } }
    },
    /** The user types into the session while it is idle: a turn of theirs starts and runs until `turnEnd`. */
    userTurn: (sessionId: string) => {
      const agent = agentOf(sessionId)
      agent.turn++
      agent.running = true
      const typed = { id: `typed-${agent.turn}`, role: 'user', content: [{ type: 'text', text: '顺便看看定价' }], source: { kind: 'user' } }
      emit(sessionId, 'turn/start', { turn: agent.turn })
      if (claimEvents) ctx.emit('agent/inbox/claimed', { agent, message: typed, turn: agent.turn } as never)
      emit(sessionId, 'user/message', typed)
    },
    /** From now on the session's turns claim their message and then stop before recording it; end them with `turnEnd`. */
    failBeforeRecording: (sessionId: string) => { unrecorded.add(sessionId) },
    /** From now on claims are not announced, as from a DSH without `agent/inbox/claimed`. */
    withoutClaimEvents: () => { claimEvents = false },
    /** Any other session event. */
    event: emit,
    /** Sets what the next model call streams. */
    respond: (next: Chunk[]) => { chunks = next },
  }
}
export type DshHost = ReturnType<typeof dshHost>
