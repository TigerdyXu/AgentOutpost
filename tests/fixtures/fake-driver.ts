/**
 * A `SessionDriver` that plays the research agent from a script, and a clock whose timers fire at once. The script is
 * keyed by session id prefix (`'outpost-recommend-'`, `'outpost-baseline-'` …; the longest matching key wins); its entry
 * gets each round of a matching session and plays it, calling the session's tools as the agent would, and says how the
 * round ended. A session no entry matches ends every round `completed` without calling a tool. Every `run`, `nudge`,
 * `archive`, `startInteractive` and `rebind` is recorded.
 */
import type { Usage } from '../../src/core/types.ts'
import type { Clock, SessionDriver, SessionOutcome, SessionSpec, ToolSpec } from '../../src/host/ports.ts'

export const usage = (over: Partial<Usage> = {}): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, ...over })
export const completed = (used: Partial<Usage> = {}): SessionOutcome => ({ reason: 'completed', usage: usage(used) })
export const failure = (error: string, used: Partial<Usage> = {}): SessionOutcome => ({ reason: 'error', usage: usage(used), error })

/** One round of a session, as the script sees it. */
export interface Round {
  kind: 'run' | 'nudge'
  sessionId: string
  /** What the session was told this round: the prompt of a run, the text of a nudge. */
  text: string
  /** The spec of the session's latest `run`. */
  spec: SessionSpec
  /** 1 for the session's first round; every run and nudge counts. */
  number: number
  signal: AbortSignal
  /** Calls one of the session's tools by name and returns its answer. */
  call(name: string, args?: unknown): Promise<unknown>
  /** Calls `outpost_done`. */
  done(summary?: string): Promise<unknown>
}
export type Play = (round: Round) => SessionOutcome | Promise<SessionOutcome>

export class FakeDriver implements SessionDriver {
  readonly runs: SessionSpec[] = []
  readonly nudges: { sessionId: string; text: string }[] = []
  readonly archived: string[] = []
  readonly interactive: SessionSpec[] = []
  /** Sessions given their tools again (`rebind`), in order. */
  readonly rebound: { sessionId: string; tools: ToolSpec[] }[] = []
  closed = false
  /** Sessions DSH no longer has: `archive` throws for them. */
  readonly missing = new Set<string>()
  private readonly specs = new Map<string, SessionSpec>()
  private readonly rounds = new Map<string, number>()

  constructor(public script: Record<string, Play> = {}) {}

  async run(spec: SessionSpec, signal: AbortSignal): Promise<SessionOutcome> {
    this.runs.push(spec)
    this.specs.set(spec.sessionId, spec)
    return this.play('run', spec.sessionId, spec.prompt, signal)
  }

  async nudge(sessionId: string, text: string, signal: AbortSignal): Promise<SessionOutcome> {
    this.nudges.push({ sessionId, text })
    if (!this.specs.has(sessionId)) throw new Error(`session "${sessionId}" does not exist`)
    return this.play('nudge', sessionId, text, signal)
  }

  async startInteractive(spec: SessionSpec): Promise<void> {
    this.interactive.push(spec)
  }

  rebind(sessionId: string, tools: ToolSpec[]): void {
    this.rebound.push({ sessionId, tools })
  }

  close(): void {
    this.closed = true
  }

  async archive(sessionId: string): Promise<void> {
    if (this.missing.has(sessionId)) throw new Error(`session "${sessionId}" not found`)
    this.archived.push(sessionId)
  }

  private async play(kind: Round['kind'], sessionId: string, text: string, signal: AbortSignal): Promise<SessionOutcome> {
    const spec = this.specs.get(sessionId)!
    const number = (this.rounds.get(sessionId) ?? 0) + 1
    this.rounds.set(sessionId, number)
    const key = Object.keys(this.script).filter(prefix => sessionId.startsWith(prefix)).sort((a, b) => b.length - a.length)[0]
    if (key === undefined) return completed()
    const call = (name: string, args?: unknown) => {
      const tool = spec.tools.find(t => t.name === name)
      if (!tool) throw new Error(`session "${sessionId}" has no tool ${name}`)
      return tool.execute(args)
    }
    return this.script[key]!({ kind, sessionId, text, spec, number, signal, call, done: (summary = '完成') => call('outpost_done', { summary }) })
  }
}

/**
 * A clock that stands still until a timer is due, and runs every timer on the next microtask, moving the time to it.
 * `waits` records the delay asked of each timer, in milliseconds.
 */
export function instantClock(start: Date) {
  let time = start
  const waits: number[] = []
  const clock: Clock = {
    now: () => time,
    at(when, fn) {
      waits.push(when.getTime() - time.getTime())
      let live = true
      queueMicrotask(() => {
        if (!live) return
        if (when.getTime() > time.getTime()) time = when
        fn()
      })
      return () => { live = false }
    },
    tick: () => () => {}, // time here moves only by the timers' own waits: there is no minute to tick
  }
  return { clock, waits, set(when: Date) { time = when } }
}

/** A promise with its resolver, for holding a scripted round until the test lets it go. */
export function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, open: () => resolve() }
}

/** Lets every pending promise callback and I/O callback run. */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>(resolve => setImmediate(resolve))
}
