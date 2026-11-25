/**
 * An in-memory stand-in for the parts of DSH the adapters use (as superagent's `tests/fixtures/host.ts` builds one): a Cordis
 * `Context` providing `sessionController`, `workspaceRegistry`, `sessionPersistence`, `llm` and `agentDefaultModel`, and fake
 * agents with their own `agent.ctx.tools`. Like DSH, creating or resuming a session emits `agent/created` before it resolves;
 * a message sent to an idle agent starts a turn at once (`turn/start`, then the message as `user/message`), and one sent
 * while a turn runs waits for that turn to end. The test plays the model: `assistant(...)` and `turnEnd(...)` emit what
 * DSH would.
 */
import { Context } from '@deepseek-ai/cordis'
import { vi } from 'vitest'

/** A tool as `agent.ctx.tools.register` receives it. */
export interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render(args: unknown, value: unknown): { type: string; text?: string }[] }
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
}

export interface SentMessage { id: string; role: string; content: { type: string; text: string }[]; source: { kind: string; form?: string } }

export interface FakeAgent {
  id: string
  ctx: Context
  session: { id: string }
  model: { select: ReturnType<typeof vi.fn> }
  followup: ReturnType<typeof vi.fn>
  /** Number of the latest turn, 0 before the first. */
  turn: number
  /** Whether the latest turn has not ended yet. */
  running: boolean
  /** Messages waiting for the next turn. */
  queued: SentMessage[]
}

/** A model chunk, as `ctx.llm.stream` yields them. */
export type Chunk = Record<string, unknown> & { type: string }

export function dshHost() {
  const ctx = new Context()
  const agents = new Map<string, FakeAgent>()
  /** Sessions stored on disk, live or not. */
  const stored = new Set<string>()
  const tools = new Map<string, Map<string, RegisteredTool>>()
  const sent = new Map<string, SentMessage[]>()

  const emit = (sessionId: string, type: string, data: unknown) => {
    const agent = agents.get(sessionId)
    ctx.emit('session/event', (agent?.session ?? { id: sessionId }) as never, { type, seq: 0, time: Date.now(), data } as never)
  }
  /** The next turn starts, and its first step takes the oldest waiting message into the history. */
  const next = (agent: FakeAgent) => {
    const message = agent.queued.shift()
    if (!message) { agent.running = false; return }
    agent.turn++
    agent.running = true
    emit(agent.id, 'turn/start', { turn: agent.turn })
    emit(agent.id, 'user/message', message)
  }

  /** A new agent instance for `sessionId` (a fresh one on every create or resume, as DSH does), announced with `agent/created`. */
  const spawn = async (sessionId: string, kind: 'new' | 'resume') => {
    const agentCtx = new Context()
    const own = new Map<string, RegisteredTool>()
    tools.set(sessionId, own)
    agentCtx.reflect.provide('tools', {
      register: vi.fn((tool: RegisteredTool) => {
        if (own.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`)
        own.set(tool.name, tool)
        return () => { if (own.get(tool.name) === tool) own.delete(tool.name) }
      }),
    })
    const agent: FakeAgent = {
      id: sessionId, ctx: agentCtx, session: { id: sessionId }, turn: 0, running: false, queued: [],
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
      await ctx.serial('agent/created', { agent, source: { kind: kind === 'new' ? 'startup' : 'resume' } } as never)
    } catch (error) {
      // As in DSH, a listener that throws fails the creation: the agent is gone again.
      agents.delete(sessionId)
      if (!wasStored) stored.delete(sessionId)
      throw error
    }
    return agent
  }

  const sessionController = {
    resolveAgent: vi.fn(async (sessionId: string) => {
      const live = agents.get(sessionId)
      if (live) return { agent: live }
      if (stored.has(sessionId)) return { agent: await spawn(sessionId, 'resume') }
      return { error: Object.assign(new Error(`session "${sessionId}" not found`), { code: 'session/not-found' }) }
    }),
    create: vi.fn(async (request: { sessionId: string; workspaceId: string; agentPreset?: string }) => {
      await spawn(request.sessionId, 'new')
      return { sessionId: request.sessionId, agentPreset: request.agentPreset }
    }),
    rename: vi.fn(async (request: { sessionId: string; title: string }) => ({ title: request.title, seq: 1 })),
    cancel: vi.fn((request: { sessionId: string }) => {
      if (!agents.has(request.sessionId)) throw Object.assign(new Error('not attached'), { code: 'session/not-found' })
      return { accepted: true }
    }),
  }
  const workspaceRegistry = {
    create: vi.fn(async (path: string, _title?: string) => ({ id: `ws-${path}`, path })),
    archiveSession: vi.fn(async (_sessionId: string, _options?: { stopActivity?: boolean }) => {}),
  }
  const sessionPersistence = { flush: vi.fn(async () => {}) }
  /** What the next `llm.stream` call yields. */
  let chunks: Chunk[] = []
  const llm = {
    stream: vi.fn((_options: Record<string, unknown>) => (async function* () { for (const chunk of chunks) yield chunk })()),
  }
  const agentDefaultModel = { currentSelection: vi.fn(() => ({ provider: 'deepseek-account', model: 'deepseek-flash' })) }

  for (const [name, service] of Object.entries({ sessionController, workspaceRegistry, sessionPersistence, llm, agentDefaultModel }))
    ctx.reflect.provide(name, service)

  const agentOf = (sessionId: string): FakeAgent => {
    const agent = agents.get(sessionId)
    if (!agent) throw new Error(`no agent for ${sessionId}`)
    return agent
  }

  return {
    ctx, sessionController, workspaceRegistry, sessionPersistence, llm, agentDefaultModel,
    agent: agentOf,
    /** The tools registered on the session's current agent, by name. */
    tools: (sessionId: string) => tools.get(sessionId) ?? new Map<string, RegisteredTool>(),
    /** The messages sent to the session, oldest first. */
    sent: (sessionId: string) => sent.get(sessionId) ?? [],
    /** A session that exists on disk with no live agent, as after a restart of DSH. */
    store: (sessionId: string) => { stored.add(sessionId) },
    /** Another agent (not Outpost's) being created, such as a chat the user opens. */
    spawn: (sessionId: string) => spawn(sessionId, 'new'),
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
      emit(sessionId, 'turn/start', { turn: agent.turn })
      emit(sessionId, 'user/message', { id: `typed-${agent.turn}`, role: 'user', content: [{ type: 'text', text: '顺便看看定价' }], source: { kind: 'user' } })
    },
    /** Any other session event. */
    event: emit,
    /** Sets what the next model call streams. */
    respond: (next: Chunk[]) => { chunks = next },
  }
}
export type DshHost = ReturnType<typeof dshHost>
