/**
 * What Outpost needs from the outside world, as plain interfaces: the agent sessions that do the research, a model for
 * one-shot writing, the clock, and the icon downloader. The code in this package talks only to these; the adapters that
 * back them with DSH (and the fakes the tests use) live elsewhere. Nothing here imports from `@deepseek-ai/*`.
 */
import type { z } from 'zod'
import type { ModelRef } from '../core/models.ts'
import type { Id, Usage } from '../core/types.ts'

/** A tool the research agent can call. `schema` describes the arguments; `execute` gets them as the model sent them. */
export interface ToolSpec<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  execute(args: z.infer<S>): Promise<unknown>
}

/**
 * One agent session: what to call it, what to tell it, which tools it may use, and which model. null keeps the host's
 * choice (its default model); a model is used as given, even one the host no longer offers (the session then fails).
 */
export interface SessionSpec {
  sessionId: string
  title: string
  prompt: string
  tools: ToolSpec[]
  model: ModelRef | null
}

/** How one round of a session ended and what it cost in tokens. */
export interface SessionOutcome {
  reason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'interrupted' | 'blocked' | 'timeout'
  usage: Usage
  error?: string
}

export interface SessionDriver {
  /** One round: create or continue the session, attach the tools, send the prompt, wait for the round to end. */
  run(spec: SessionSpec, signal: AbortSignal): Promise<SessionOutcome>
  /** Say one more thing in the same session and wait for that round to end. */
  nudge(sessionId: string, text: string, signal: AbortSignal): Promise<SessionOutcome>
  /**
   * A follow-up chat for the user: create the session (on the host's ordinary chat preset, not the research one), choose
   * its model, and send the message, without waiting for an answer.
   */
  startInteractive(spec: SessionSpec): Promise<void>
  /**
   * Hears what every follow-up chat uses from now on, one reply or one search at a time (`usage`), for as long as the user
   * keeps chatting: Outpost adds it to the chat's run. Research sessions are not reported here (their rounds return it).
   */
  onChatUsage(listener: (sessionId: string, usage: Usage) => void): void
  /** Gives an existing session (a follow-up chat, after a restart) its tools again, without sending it anything. */
  rebind(sessionId: string, tools: ToolSpec[]): void
  /** Takes back every tool registered so far: Outpost is stopping. */
  close(): void
  /**
   * Lets go of the live state of a research session whose run is over: its agent, and with it the browser it launched (one
   * Playwright MCP server and one Chrome per session; without this they stay until the host restarts). The session itself
   * stays, and can still be opened in the host to read. A follow-up chat (the user's own) is left alone. Never throws: a
   * failure is logged.
   */
  release(sessionId: string): Promise<void>
  archive(sessionId: string): Promise<void>
}

/** One-shot text completion, for writing that needs no tools (the day's gist, say). */
export interface ModelClient {
  complete(req: { system: string; user: string }, signal: AbortSignal): Promise<{ text: string; usage: Usage }>
}

export interface Clock {
  now(): Date
  /** Runs `fn` at `when`; the returned function cancels it. */
  at(when: Date, fn: () => void): () => void
  /** Calls `fn` about once a minute, on the wall clock's own steps, until the returned function cancels it. */
  tick(fn: () => void): () => void
}

export interface IconFetcher {
  /** Tries each candidate address in turn and returns the local file path of the first usable image, or null. */
  fetch(productId: Id, candidates: string[]): Promise<string | null>
}
