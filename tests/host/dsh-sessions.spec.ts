import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  chooseResearchPreset, DshSessionDriver, isResearchAgent, RESEARCH_PRESET_BROKEN, RESEARCH_TOOL_REFUSED, UNSAFE_BROWSER_TOOL, toolParameters,
} from '../../src/host/dsh-sessions.ts'
import type { SessionSpec, ToolSpec } from '../../src/host/ports.ts'
import { researchTools } from '../../src/host/tools.ts'
import { dshHost, type DshHost } from '../fixtures/dsh-context.ts'

let dir: string
let workspaceDir: string
let host: DshHost
let driver: DshSessionDriver
let signal: AbortSignal

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-dsh-'))
  workspaceDir = join(dir, 'data', 'workspace') // not there yet: the driver makes it
  host = dshHost()
  driver = new DshSessionDriver(host.ctx, workspaceDir)
  signal = new AbortController().signal
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** A tool that records what it was called with and answers `answer(args)`. */
const probe = (name: string, answer: (args: unknown) => unknown = () => ({ ok: true })) => {
  const calls: unknown[] = []
  const tool: ToolSpec = { name, description: `${name} 的说明`, schema: z.object({ summary: z.string() }), execute: async args => { calls.push(args); return answer(args) } }
  return { tool, calls }
}
const specOf = (over: Partial<SessionSpec> = {}): SessionSpec =>
  ({ sessionId: 'outpost-daily-p1', title: '前哨 · Cursor · 日更', prompt: '调用 outpost_done，summary 写 ok', tools: [probe('outpost_done').tool], model: null, ...over })
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
/** Whether `p` has settled by now. */
const settled = async (p: Promise<unknown>) => { let done = false; void p.then(() => { done = true }, () => { done = true }); await new Promise(r => setTimeout(r, 0)); return done }

describe('DshSessionDriver.run', () => {
  it('creates a session with the outpost-researcher preset and renames it', async () => {
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    expect(existsSync(workspaceDir)).toBe(true)
    expect(host.workspaceRegistry.create).toHaveBeenCalledWith(workspaceDir, '前哨')
    // Outpost makes the research session itself (`agents.create`), so that it holds the handle that lets it go again
    // (`release`); DSH's own create would keep that handle. As DSH composes a session, it runs on the preset, in the
    // 「前哨」 workspace's directory, and follows DSH's default model until the spec chooses one.
    expect(host.sessionController.create).not.toHaveBeenCalled()
    expect(host.created).toHaveLength(1)
    const { options } = host.created[0]!
    expect(options).toMatchObject({ sessionId: 'outpost-daily-p1', meta: { cwd: workspaceDir, agentPreset: 'outpost-researcher' } })
    expect(host.agentPresets.mount).toHaveBeenCalledExactlyOnceWith(host.agent('outpost-daily-p1').ctx, 'outpost-researcher')
    expect(options.agentOptions).toMatchObject({ provider: 'deepseek-account', model: 'deepseek-flash' })
    host.agentDefaultModel.currentSelection.mockReturnValue({ provider: 'ollama', model: 'qwen3' })
    expect(options.agentOptions).toMatchObject({ provider: 'ollama', model: 'qwen3' }) // read anew, as DSH's own sessions do
    expect(host.workspace(workspaceDir)!.attachSession).toHaveBeenCalledExactlyOnceWith('outpost-daily-p1')
    expect(host.sessionController.rename).toHaveBeenCalledWith({ sessionId: 'outpost-daily-p1', title: '前哨 · Cursor · 日更' })
    // The prompt goes in as a message of Outpost's own, not as one the user typed, and is made durable.
    const [message] = host.sent('outpost-daily-p1')
    expect(message).toEqual({ id: expect.stringMatching(/^outpost:[0-9a-f-]{36}$/), role: 'user', content: [{ type: 'text', text: '调用 outpost_done，summary 写 ok' }], source: { kind: 'dsh-outpost', form: 'relay' } })
    expect(host.sessionPersistence.flush).toHaveBeenCalled()
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    expect(await p).toEqual({ reason: 'completed', usage: zero })
  })

  it('continues a session that already exists instead of creating it again', async () => {
    host.store('outpost-daily-p1') // on disk from before a restart, no live agent
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    expect(host.sessionController.resolveAgent).toHaveBeenCalledWith('outpost-daily-p1')
    expect(host.agents.create).not.toHaveBeenCalled()
    expect(host.sessionController.rename).not.toHaveBeenCalled()
    expect([...host.tools('outpost-daily-p1').keys()]).toEqual(['outpost_done']) // the resumed agent gets the tools too
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    expect(await p).toMatchObject({ reason: 'completed' })

    // A second round of the same live session sends a second message into the same agent.
    const again = driver.run(specOf({ prompt: '再查一遍' }), signal)
    await host.started('outpost-daily-p1', 2)
    expect(host.agents.create).not.toHaveBeenCalled()
    expect(host.sent('outpost-daily-p1').map(m => m.content[0]!.text)).toEqual(['调用 outpost_done，summary 写 ok', '再查一遍'])
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    expect(await again).toMatchObject({ reason: 'completed' })
  })

  it('registers the spec tools only on its own session', async () => {
    const a = probe('outpost_done', args => ({ ok: true, got: args, skipped: undefined }))
    const b = probe('outpost_read')
    const pa = driver.run(specOf({ sessionId: 'outpost-a', tools: [a.tool] }), signal)
    const pb = driver.run(specOf({ sessionId: 'outpost-b', tools: [b.tool] }), signal)
    await host.started('outpost-a'); await host.started('outpost-b')
    await host.spawn('outpost-unknown') // an outpost- session this driver has no tools for
    await host.spawn('chat-1') // a session of the user's own
    expect([...host.tools('outpost-a').keys()]).toEqual(['outpost_done'])
    expect([...host.tools('outpost-b').keys()]).toEqual(['outpost_read'])
    expect(host.tools('outpost-unknown').size).toBe(0)
    expect(host.tools('chat-1').size).toBe(0)

    // The registered tool hands the model's arguments over as they are and answers with plain JSON.
    const registered = host.tools('outpost-a').get('outpost_done')!
    expect(registered.description).toBe('outpost_done 的说明')
    expect(registered.parameters).toEqual(toolParameters(a.tool.schema))
    expect(registered.output.schema).toEqual({ type: 'object', additionalProperties: true })
    const value = await registered.execute({ summary: 'ok', extra: null }, { signal })
    expect(a.calls).toEqual([{ summary: 'ok', extra: null }])
    expect(value).toEqual({ ok: true, got: { summary: 'ok', extra: null } }) // no `undefined` left for DSH to refuse as lossy
    expect(registered.output.render({}, value)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
    expect(b.calls).toEqual([])

    // An agent made afresh for the same session (after a compaction or a restart) gets the same tools.
    await host.spawn('outpost-a')
    expect([...host.tools('outpost-a').keys()]).toEqual(['outpost_done'])
    host.turnEnd('outpost-a', { kind: 'completed' }, 1); host.turnEnd('outpost-b', { kind: 'completed' })
    await Promise.all([pa, pb])
  })

  it('replaces the tools of a session that runs again with other tools', async () => {
    const first = driver.run(specOf({ tools: [probe('outpost_read').tool, probe('outpost_done').tool] }), signal)
    await host.started('outpost-daily-p1')
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await first
    const second = driver.run(specOf({ tools: [probe('outpost_done').tool, probe('outpost_submit_facts').tool] }), signal)
    await host.started('outpost-daily-p1', 2)
    expect([...host.tools('outpost-daily-p1').keys()].sort()).toEqual(['outpost_done', 'outpost_submit_facts'])
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await second
  })

  it('reports tools DSH refuses to the caller, without failing the agent DSH is creating', async () => {
    const twice = [probe('outpost_done').tool, probe('outpost_done').tool] // DSH refuses a second tool of the same name
    await expect(driver.run(specOf({ tools: twice }), signal)).rejects.toThrow('already registered')
    // The listener of `agent/created` swallowed it (a throw there fails the creation); the session and its agent exist.
    expect(host.agents.create).toHaveBeenCalledTimes(1)
    expect(host.agent('outpost-daily-p1').id).toBe('outpost-daily-p1')
    expect(host.tools('outpost-daily-p1').size).toBe(0) // the first was taken off again
    expect(host.sent('outpost-daily-p1')).toEqual([])
  })

  // M1.4: a plain `dsh plugin add` of Outpost lacks the browser packages; research still runs, on the preset without a browser.
  it('runs research on the preset without a browser when the browser preset does not load, and logs why once per reason', async () => {
    const MISSING = 'browser-use-playwright (@deepseek-ai/dsh-experimental-browser-use-playwright-mcp): Cannot find package'
    host.breakPreset('outpost-researcher', MISSING)
    const warn = vi.spyOn(Object.getPrototypeOf(host.ctx.logger), 'warn').mockImplementation(() => {})
    try {
      const p = driver.run(specOf(), signal)
      await host.started('outpost-daily-p1')
      // Made as any research session, on the other preset: what DSH keeps in its header and what it is composed from.
      expect(host.created).toHaveLength(1)
      expect(host.created[0]!.options).toMatchObject({ sessionId: 'outpost-daily-p1', meta: { cwd: workspaceDir, agentPreset: 'outpost-researcher-basic' } })
      expect(host.agentPresets.mount).toHaveBeenCalledExactlyOnceWith(host.agent('outpost-daily-p1').ctx, 'outpost-researcher-basic')
      expect(host.agentPresets.resolve).toHaveBeenCalledWith('outpost-researcher')
      expect(host.agentPresets.resolve).toHaveBeenCalledWith('outpost-researcher-basic')
      expect([...host.tools('outpost-daily-p1').keys()]).toEqual(['outpost_done'])
      // Still a research session: a browser the profile turns on for every session must not run arbitrary code here either.
      expect(host.denial('outpost-daily-p1', UNSAFE_BROWSER_TOOL)).toEqual({ reason: RESEARCH_TOOL_REFUSED })
      host.turnEnd('outpost-daily-p1', { kind: 'completed' })
      expect(await p).toEqual({ reason: 'completed', usage: zero })
      // Why there is no browser goes to DSH's log once, not with every session.
      const said = () => warn.mock.calls.filter(call => String(call[0]).includes('without Outpost\'s own browser'))
      expect(said()).toEqual([[expect.stringContaining('%s'), 'outpost-researcher-basic', 'outpost-researcher', MISSING]])
      const again = driver.run(specOf({ sessionId: 'outpost-daily-p2' }), signal)
      await host.started('outpost-daily-p2')
      host.turnEnd('outpost-daily-p2', { kind: 'completed' })
      await again
      expect(host.created.map(c => c.options.meta?.agentPreset)).toEqual(['outpost-researcher-basic', 'outpost-researcher-basic'])
      expect(said()).toHaveLength(1)
      // Another reason is said too.
      host.breakPreset('outpost-researcher', 'Unknown agent preset: outpost-researcher')
      const third = driver.run(specOf({ sessionId: 'outpost-daily-p3' }), signal)
      await host.started('outpost-daily-p3')
      host.turnEnd('outpost-daily-p3', { kind: 'completed' })
      await third
      expect(said()).toHaveLength(2)
      expect(said()[1]).toContain('Unknown agent preset: outpost-researcher')
    } finally {
      warn.mockRestore()
    }
    // Once the browser preset loads (the packages installed, DSH restarted), new research sessions get the browser again.
    host.breakPreset('outpost-researcher', null)
    const p = driver.run(specOf({ sessionId: 'outpost-daily-p4' }), signal)
    await host.started('outpost-daily-p4')
    expect(host.created.at(-1)!.options.meta).toMatchObject({ agentPreset: 'outpost-researcher' })
    host.turnEnd('outpost-daily-p4', { kind: 'completed' })
    await p
  })

  it('runs research on the preset without a browser when a Playwright browser for the whole profile clashes with the preset\'s own', async () => {
    // Both would start an MCP server named playwright-mcp for the session; DSH would refuse the second only while creating
    // the session, after writing it. The preset without a browser has none to clash: the profile's is the one it gets.
    host.ctx.reflect.provide('browserUse', { providerName: 'playwright-mcp' })
    host.agentPresets.inspectCompositions.mockReturnValue([{ id: 'outpost-researcher', modules: [{ moduleName: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', useHostBase: true }], leakedServices: [] }])
    const warn = vi.spyOn(Object.getPrototypeOf(host.ctx.logger), 'warn').mockImplementation(() => {})
    try {
      const p = driver.run(specOf(), signal)
      await host.started('outpost-daily-p1')
      expect(host.created[0]!.options.meta).toMatchObject({ agentPreset: 'outpost-researcher-basic' })
      expect(host.agentPresets.mount).toHaveBeenCalledExactlyOnceWith(host.agent('outpost-daily-p1').ctx, 'outpost-researcher-basic')
      expect(host.denial('outpost-daily-p1', UNSAFE_BROWSER_TOOL)).toEqual({ reason: RESEARCH_TOOL_REFUSED })
      host.turnEnd('outpost-daily-p1', { kind: 'completed' })
      expect(await p).toMatchObject({ reason: 'completed' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('without Outpost\'s own browser'), 'outpost-researcher-basic', 'outpost-researcher', expect.stringContaining('playwright-mcp'))
    } finally {
      warn.mockRestore()
    }
  })

  it('refuses at once a research session neither preset can compose, saying why, and writes no session', async () => {
    const warn = vi.spyOn(Object.getPrototypeOf(host.ctx.logger), 'warn').mockImplementation(() => {})
    try {
      // Neither loads (Outpost's patch was applied without the rows DSH needs for both, say).
      host.breakPreset('outpost-researcher', 'browser-use-playwright: Cannot find package')
      host.breakPreset('outpost-researcher-basic', 'tool-web (@deepseek-ai/dsh-tool-web): Cannot find package')
      await expect(driver.run(specOf(), signal)).rejects.toThrow(RESEARCH_PRESET_BROKEN)
      // In plain words, for 运行记录: no longer the browser's fault, and where to look.
      expect(RESEARCH_PRESET_BROKEN).toBe('前哨的调研预设加载不了，推荐、建档、核查和日更都跑不了。详情在桌面版的日志里。')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('%s'), expect.stringMatching(/outpost-researcher: browser-use-playwright: Cannot find package.*outpost-researcher-basic: tool-web/))
      // DSH does not know either preset at all.
      host.agentPresets.resolve.mockImplementation(async (id: string) => { throw Object.assign(new Error(`Unknown agent preset: ${id}`), { code: 'agent-preset/not-found' }) })
      await expect(driver.run(specOf(), signal)).rejects.toThrow(RESEARCH_PRESET_BROKEN)
      expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('%s'), expect.stringContaining('Unknown agent preset: outpost-researcher-basic'))

      // None of it made a session, sent anything, or left tools waiting for one.
      expect(host.agents.create).not.toHaveBeenCalled()
      expect(host.sessionController.create).not.toHaveBeenCalled()
      expect(host.workspaceRegistry.create).not.toHaveBeenCalled()
      expect(await host.sessionController.resolveAgent('outpost-daily-p1')).toMatchObject({ error: { code: 'session/not-found' } })
      await host.spawn('outpost-daily-p1')
      expect(host.tools('outpost-daily-p1').size).toBe(0)
    } finally {
      warn.mockRestore()
    }
    // A 追问 chat runs DSH's standard preset: the research presets' state is not its concern.
    await driver.startInteractive({ sessionId: 'outpost-followup-1', title: '追问 · Cursor', prompt: '团队版多少钱？', tools: [probe('outpost_read').tool], model: null })
    expect(host.sessionController.create).toHaveBeenCalledOnce()
    // Once one of them loads, research opens again.
    host.agentPresets.resolve.mockImplementation(async (id: string) => id === 'outpost-researcher-basic' ? { id } : { id, broken: 'Cannot find package' })
    const p = driver.run(specOf({ sessionId: 'outpost-daily-p2' }), signal)
    await host.started('outpost-daily-p2')
    expect(host.created[0]!.options.meta).toMatchObject({ agentPreset: 'outpost-researcher-basic' })
    host.turnEnd('outpost-daily-p2', { kind: 'completed' })
    expect(await p).toMatchObject({ reason: 'completed' })
  })

  it('refuses a session id without the outpost- prefix', async () => {
    await expect(driver.run(specOf({ sessionId: 'daily-p1' }), signal)).rejects.toThrow('outpost-')
    expect(host.agents.create).not.toHaveBeenCalled()
  })

  it('resolves with summed usage when the turn ends', async () => {
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    // DSH counts input disjointly: inputTokens is the input that missed the cache, cacheReadTokens the input read from it
    // (@deepseek-ai/dsh-llm TokenUsage; token-meter's `uncachedInputTokens: inputTokens`). Cache writes are billed as misses.
    host.assistant('outpost-daily-p1', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 })
    host.assistant('outpost-daily-p1', { inputTokens: 30, outputTokens: 5, cacheWriteTokens: 7 })
    host.assistant('outpost-daily-p1', undefined) // a step whose adapter reported no usage
    host.assistant('outpost-other', { inputTokens: 999, outputTokens: 999, cacheReadTokens: 999 }, 1) // another session
    host.assistant('outpost-daily-p1', { inputTokens: 999, outputTokens: 999 }, 0) // an earlier turn of this session
    host.turnEnd('outpost-daily-p1', { kind: 'completed' }, 0) // the end of an earlier turn is not this round's end
    expect(await settled(p)).toBe(false)
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    expect(await p).toEqual({ reason: 'completed', usage: { inputTokens: 137, outputTokens: 25, cacheReadTokens: 40 } })
  })

  it('counts the web searches its turn makes, each a hidden model call DSH reports no usage for', async () => {
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    host.assistant('outpost-daily-p1', { inputTokens: 100, outputTokens: 20 })
    host.search('outpost-daily-p1')
    host.search('outpost-daily-p1')
    host.search('outpost-other') // another session's search
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    expect(await p).toEqual({ reason: 'completed', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, searches: 2 } })
  })

  it('waits for the turn that takes its message, not one that was already running', async () => {
    const first = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await first
    host.userTurn('outpost-daily-p1') // turn 2: the user typed something, and it is still running
    // The user typed one more thing, which waits for the next turn ahead of ours.
    host.agent('outpost-daily-p1').followup({ id: 'typed-later', role: 'user', content: [{ type: 'text', text: '还有竞品' }], source: { kind: 'user' } })
    const p = driver.nudge('outpost-daily-p1', '继续', signal)
    await vi.waitFor(() => { expect(host.sent('outpost-daily-p1')).toHaveLength(3) })
    host.assistant('outpost-daily-p1', { inputTokens: 500, outputTokens: 500 })
    host.turnEnd('outpost-daily-p1', { kind: 'completed' }) // the user's turn ends; turn 3 takes their second message
    await host.started('outpost-daily-p1', 3)
    host.assistant('outpost-daily-p1', { inputTokens: 300, outputTokens: 300 })
    host.turnEnd('outpost-daily-p1', { kind: 'completed' }) // and ends; ours starts next
    expect(await settled(p)).toBe(false)
    await host.started('outpost-daily-p1', 4)
    host.assistant('outpost-daily-p1', { inputTokens: 10, outputTokens: 2 })
    host.turnEnd('outpost-daily-p1', { kind: 'max-tokens' })
    expect(await p).toEqual({ reason: 'max-tokens', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 } })
  })

  it('keeps concurrent rounds of different sessions apart, ending in either order', async () => {
    const pa = driver.run(specOf({ sessionId: 'outpost-a' }), signal)
    const pb = driver.run(specOf({ sessionId: 'outpost-b' }), signal)
    await host.started('outpost-a'); await host.started('outpost-b')
    host.assistant('outpost-a', { inputTokens: 1, outputTokens: 1 })
    host.assistant('outpost-b', { inputTokens: 2, outputTokens: 2, cacheReadTokens: 2 })
    // b started second and ends first; a keeps waiting for its own end.
    host.turnEnd('outpost-b', { kind: 'error', error: { message: 'HTTP 503 from provider', code: 'PROVIDER_ERROR' } })
    expect(await pb).toEqual({ reason: 'error', usage: { inputTokens: 2, outputTokens: 2, cacheReadTokens: 2 }, error: 'HTTP 503 from provider' })
    expect(await settled(pa)).toBe(false)
    host.assistant('outpost-a', { inputTokens: 3, outputTokens: 3 })
    host.turnEnd('outpost-a', { kind: 'completed' })
    expect(await pa).toEqual({ reason: 'completed', usage: { inputTokens: 4, outputTokens: 4, cacheReadTokens: 0 } })
  })

  it('reports the error of a turn that fails after taking its message but before recording it', async () => {
    // DSH claims the message first, then checks the model, tools, system prompt, pre-step hook and request; a failure there
    // ends the turn with no `user/message` (a wrong model id in Outpost's settings fails in `prepareCall`, say).
    host.failBeforeRecording('outpost-daily-p1')
    const timer = new AbortController()
    const p = driver.run(specOf({ model: { provider: 'deepseek-official', model: 'deepseek-v9' } }), timer.signal)
    await host.started('outpost-daily-p1')
    host.turnEnd('outpost-daily-p1', { kind: 'error', error: { message: 'model "deepseek-v9" is not available from provider "deepseek-official"', code: 'MODEL_NOT_FOUND' } })
    expect(await p).toEqual({ reason: 'error', usage: zero, error: 'model "deepseek-v9" is not available from provider "deepseek-official"' })
    expect(timer.signal.aborted).toBe(false) // it did not wait for the time limit
    expect(host.sessionController.cancel).not.toHaveBeenCalled()
  })

  it('reports a turn that a pre-step hook blocks before its message is recorded', async () => {
    host.failBeforeRecording('outpost-daily-p1')
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    host.turnEnd('outpost-daily-p1', { kind: 'blocked' })
    expect(await p).toEqual({ reason: 'blocked', usage: zero })
  })

  it('still knows its turn by the recorded message when DSH does not announce the claim', async () => {
    host.withoutClaimEvents()
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    host.assistant('outpost-daily-p1', { inputTokens: 9, outputTokens: 1 })
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    expect(await p).toEqual({ reason: 'completed', usage: { inputTokens: 9, outputTokens: 1, cacheReadTokens: 0 } })
  })

  it('reports how the turn ended', async () => {
    const reasons: [Record<string, unknown> & { kind: string }, Record<string, unknown>][] = [
      [{ kind: 'aborted', reason: { kind: 'user' } }, { reason: 'aborted' }],
      [{ kind: 'blocked' }, { reason: 'blocked' }],
      [{ kind: 'interrupted' }, { reason: 'interrupted' }],
      [{ kind: 'forked' }, { reason: 'interrupted' }],
      [{ kind: 'something-new' }, { reason: 'error', error: expect.stringContaining('something-new') }],
    ]
    for (const [i, [reason, expected]] of reasons.entries()) {
      const p = driver.run(specOf(), signal)
      await host.started('outpost-daily-p1', i + 1)
      host.turnEnd('outpost-daily-p1', reason)
      expect(await p, reason.kind).toEqual({ usage: zero, ...expected })
    }
  })

  it('cancels and reports timeout when the signal aborts', async () => {
    const timer = new AbortController()
    const p = driver.run(specOf(), timer.signal)
    await host.started('outpost-daily-p1')
    host.assistant('outpost-daily-p1', { inputTokens: 50, outputTokens: 10, cacheReadTokens: 5 })
    expect(host.sessionController.cancel).not.toHaveBeenCalled()
    timer.abort()
    expect(await p).toEqual({ reason: 'timeout', usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 5 } })
    expect(host.sessionController.cancel).toHaveBeenCalledWith({ sessionId: 'outpost-daily-p1' })
    // The turn that the cancel stops ends later; it changes nothing.
    host.turnEnd('outpost-daily-p1', { kind: 'aborted', reason: { kind: 'user' } })
    expect(await p).toMatchObject({ reason: 'timeout' })
  })

  it('warns, naming the session, when a round ends without ever having seen which turn took its message', async () => {
    const warn = vi.spyOn(Object.getPrototypeOf(host.ctx.logger), 'warn').mockImplementation(() => {})
    try {
      // A DSH that neither announces the claim nor records the message: the round cannot tell its turn, and waits.
      host.withoutClaimEvents()
      host.failBeforeRecording('outpost-daily-p1')
      const timer = new AbortController()
      const p = driver.run(specOf(), timer.signal)
      await host.started('outpost-daily-p1')
      timer.abort()
      expect(await p).toEqual({ reason: 'timeout', usage: zero })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('%s'), 'outpost-daily-p1')
      expect(warn.mock.calls.at(-1)![0]).toContain('turn')

      // A round that knew its turn and simply ran out of time says nothing of the kind.
      warn.mockClear()
      const other = new AbortController()
      const q = driver.run(specOf({ sessionId: 'outpost-daily-p2' }), other.signal)
      await host.started('outpost-daily-p2') // its message is recorded (user/message): the round knows its turn
      other.abort()
      await q
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('gives up on a session whose browser never starts once its time is up, and leaves nothing behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(Object.getPrototypeOf(host.ctx.logger), 'warn').mockImplementation(() => {})
    try {
      // DSH waits for the preset's Playwright MCP server while it creates the session, with no startup timeout of its own.
      host.stallCreation()
      const limit = new AbortController()
      setTimeout(() => { limit.abort(new DOMException('The operation timed out.', 'TimeoutError')) }, 30 * 60_000)
      let outcome: unknown
      const p = driver.run(specOf(), limit.signal).then(value => { outcome = value; return value })
      await vi.waitFor(() => { expect(host.agents.create).toHaveBeenCalledOnce() })
      // The run's own signal goes to DSH as the creation's cancel (`CreateAgentOptions.signal`).
      expect(host.agents.create.mock.calls[0]![0].signal).toBe(limit.signal)
      await vi.advanceTimersByTimeAsync(29 * 60_000)
      expect(outcome).toBeUndefined() // still waiting for the browser, within its time
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await p).toEqual({ reason: 'timeout', usage: zero })
      // DSH rolled the creation back: no live agent, no handle for Outpost to hold, nothing said to anyone.
      expect(host.created).toEqual([])
      expect(host.agents.get('outpost-daily-p1')).toBeUndefined()
      expect(host.sent('outpost-daily-p1')).toEqual([])
      expect(host.sessionController.rename).not.toHaveBeenCalled()
      expect(host.sessionController.cancel).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('%s'), 'outpost-daily-p1')
      // No tools wait for the session: an agent DSH makes for it later (the user opening it, say) gets none.
      await host.spawn('outpost-daily-p1')
      expect(host.tools('outpost-daily-p1').size).toBe(0)
      await expect(driver.release('outpost-daily-p1')).resolves.toBeUndefined()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('lets go of a session DSH hands over just as its time runs out', async () => {
    const warn = vi.spyOn(Object.getPrototypeOf(host.ctx.logger), 'warn').mockImplementation(() => {})
    try {
      // DSH is done and returns the handle; the time limit fires before Outpost takes it.
      const limit = new AbortController()
      const create = host.agents.create.getMockImplementation()!
      host.agents.create.mockImplementationOnce(async options => { const handle = await create(options); limit.abort(); return handle })
      expect(await driver.run(specOf(), limit.signal)).toEqual({ reason: 'timeout', usage: zero })
      // The handle that came too late is disposed at once: no live agent (and no browser), no tools, nothing sent or titled.
      expect(host.created).toHaveLength(1)
      await vi.waitFor(() => { expect(host.created[0]!.handle.dispose).toHaveBeenCalledOnce() })
      expect(host.agents.get('outpost-daily-p1')).toBeUndefined()
      expect(host.tools('outpost-daily-p1').size).toBe(0)
      expect(host.sent('outpost-daily-p1')).toEqual([])
      expect(host.sessionController.rename).not.toHaveBeenCalled()
      await host.spawn('outpost-daily-p1')
      expect(host.tools('outpost-daily-p1').size).toBe(0)
      // A release afterwards has nothing left to end.
      await driver.release('outpost-daily-p1')
      expect(host.created[0]!.handle.dispose).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })

  it('gives up on the preset check once its time is up, before any session is made', async () => {
    const warn = vi.spyOn(Object.getPrototypeOf(host.ctx.logger), 'warn').mockImplementation(() => {})
    try {
      host.agentPresets.resolve.mockReturnValueOnce(new Promise(() => {})) // DSH's preset activation hangs
      const limit = new AbortController()
      const p = driver.run(specOf(), limit.signal)
      await vi.waitFor(() => { expect(host.agentPresets.resolve).toHaveBeenCalledOnce() })
      limit.abort()
      expect(await p).toEqual({ reason: 'timeout', usage: zero })
      expect(host.agents.create).not.toHaveBeenCalled()
      await host.spawn('outpost-daily-p1')
      expect(host.tools('outpost-daily-p1').size).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })

  it('reports timeout without sending anything when the signal has already aborted', async () => {
    const timer = new AbortController()
    timer.abort()
    expect(await driver.run(specOf(), timer.signal)).toEqual({ reason: 'timeout', usage: zero })
    expect(host.agents.create).not.toHaveBeenCalled()
    expect(host.sessionController.cancel).not.toHaveBeenCalled()
  })

  it('uses the default model when none is configured', async () => {
    const p = driver.run(specOf({ model: null }), signal)
    await host.started('outpost-daily-p1')
    expect(host.agent('outpost-daily-p1').model.select).not.toHaveBeenCalled()
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await p

    const chosen = driver.run(specOf({ sessionId: 'outpost-b', model: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }), signal)
    await host.started('outpost-b')
    expect(host.agent('outpost-b').model.select).toHaveBeenCalledWith({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    host.turnEnd('outpost-b', { kind: 'completed' })
    await chosen
  })
})

describe('chooseResearchPreset', () => {
  const PLAYWRIGHT = { moduleName: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp', useHostBase: true }

  it('chooses the browser preset, else the one without a browser, else none, saying why in DSH\'s words', async () => {
    expect(await chooseResearchPreset(host.ctx)).toEqual({ preset: 'outpost-researcher', browserProblem: null, problem: null })
    expect(host.agentPresets.resolve).not.toHaveBeenCalledWith('outpost-researcher-basic') // not asked when not needed
    host.breakPreset('outpost-researcher', 'browser-use-playwright: Cannot find package')
    expect(await chooseResearchPreset(host.ctx)).toEqual({ preset: 'outpost-researcher-basic', browserProblem: 'browser-use-playwright: Cannot find package', problem: null })
    host.breakPreset('outpost-researcher-basic', 'tool-web: Cannot find package')
    expect(await chooseResearchPreset(host.ctx)).toEqual({
      preset: null,
      browserProblem: 'browser-use-playwright: Cannot find package',
      problem: 'outpost-researcher: browser-use-playwright: Cannot find package; outpost-researcher-basic: tool-web: Cannot find package',
    })
  })

  it('passes over the browser preset when the profile\'s Playwright clashes with it, or when DSH cannot say whether it does', async () => {
    host.ctx.reflect.provide('browserUse', { providerName: 'playwright-mcp' })
    // The browser preset overridden without its browser: nothing to clash with, and the profile's browser is its browser.
    expect(await chooseResearchPreset(host.ctx)).toMatchObject({ preset: 'outpost-researcher', browserProblem: null })
    host.agentPresets.inspectCompositions.mockReturnValue([{ id: 'outpost-researcher', modules: [PLAYWRIGHT], leakedServices: [] }])
    const clash = await chooseResearchPreset(host.ctx)
    expect(clash).toMatchObject({ preset: 'outpost-researcher-basic', problem: null })
    expect(clash.browserProblem).toContain('playwright-mcp')
    // A registry that cannot list its compositions: the preset without a browser cannot clash, so it is the safe choice.
    host.agentPresets.inspectCompositions.mockImplementation(() => { throw new Error('registry stopping') })
    expect(await chooseResearchPreset(host.ctx)).toEqual({ preset: 'outpost-researcher-basic', browserProblem: 'registry stopping', problem: null })
  })

  it('has nothing to choose from without DSH\'s preset registry', async () => {
    const bare = new Context()
    expect(await chooseResearchPreset(bare)).toEqual({ preset: null, browserProblem: 'DSH has no agent preset registry', problem: 'DSH has no agent preset registry' })
  })
})

describe('the browser tool that runs arbitrary code', () => {
  it('is refused in research sessions, while the other browser tools stay', async () => {
    expect(UNSAFE_BROWSER_TOOL).toBe('mcp__playwright-mcp__browser_run_code_unsafe')
    expect(RESEARCH_TOOL_REFUSED).toBe('前哨的调研会话不能用这个工具')
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    // Installed while the agent is composed (its setup), on its own scope: DSH checks it for every call after approval.
    const agentTools = (host.agent('outpost-daily-p1').ctx as unknown as { tools: { guard: ReturnType<typeof vi.fn> } }).tools
    expect(agentTools.guard).toHaveBeenCalledOnce()
    expect(host.denial('outpost-daily-p1', 'mcp__playwright-mcp__browser_run_code_unsafe', { code: 'async page => process.exit()' }))
      .toEqual({ reason: '前哨的调研会话不能用这个工具' })
    for (const name of ['mcp__playwright-mcp__browser_navigate', 'mcp__playwright-mcp__browser_snapshot', 'mcp__playwright-mcp__browser_evaluate', 'web_fetch', 'web_search', 'outpost_done', 'browser_run_code_unsafe'])
      expect(host.denial('outpost-daily-p1', name), name).toBeUndefined()
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await p
    // It goes with the agent when the run lets the session go.
    await driver.release('outpost-daily-p1')
    expect(host.guards('outpost-daily-p1')).toEqual([])
  })

  it('is not Outpost\'s to refuse in a 追问 chat, which is the user\'s own', async () => {
    await driver.startInteractive({ sessionId: 'outpost-followup-1', title: '追问 · Cursor', prompt: '团队版多少钱？', tools: [probe('outpost_read').tool], model: null })
    expect(host.guards('outpost-followup-1')).toEqual([])
    expect(host.denial('outpost-followup-1', 'mcp__playwright-mcp__browser_run_code_unsafe')).toBeUndefined()
  })

  /** The `tools.guard` mock of the session's current agent. */
  const guardOf = (sessionId: string) => (host.agent(sessionId).ctx as unknown as { tools: { guard: ReturnType<typeof vi.fn> } }).tools.guard

  it('is refused, once, in a research session DSH reopens by itself', async () => {
    // A research run's session from before, opened again by DSH alone: Desktop restoring the last page at startup, or the
    // user opening it from the sidebar or 运行记录. DSH composes it on the research preset again (its header says so), with
    // the browser; Outpost has no run for it and never created it.
    host.store('outpost-daily-old', { agentPreset: 'outpost-researcher' })
    await host.sessionController.resolveAgent('outpost-daily-old')
    expect(host.denial('outpost-daily-old', 'mcp__playwright-mcp__browser_run_code_unsafe')).toEqual({ reason: '前哨的调研会话不能用这个工具' })
    expect(host.denial('outpost-daily-old', 'mcp__playwright-mcp__browser_navigate')).toBeUndefined()
    expect(guardOf('outpost-daily-old')).toHaveBeenCalledOnce()
    expect(host.sent('outpost-daily-old')).toEqual([]) // nothing said to it
    // Made anew on the research preset by DSH's own session controller (as M1 made research sessions): the same.
    await host.spawn('outpost-recommend-m1', { agentPreset: 'outpost-researcher' })
    expect(host.denial('outpost-recommend-m1', 'mcp__playwright-mcp__browser_run_code_unsafe')).toEqual({ reason: '前哨的调研会话不能用这个工具' })
    // A session Outpost creates gets it in its setup, and the announcement of the same agent does not add a second.
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    expect(guardOf('outpost-daily-p1')).toHaveBeenCalledOnce()
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await p
    // Every agent DSH makes for a session gets its own: after a release, the reopened research session has it again.
    await driver.release('outpost-daily-p1')
    await host.sessionController.resolveAgent('outpost-daily-p1')
    expect(guardOf('outpost-daily-p1')).toHaveBeenCalledOnce() // this agent's own mock
    expect(host.denial('outpost-daily-p1', 'mcp__playwright-mcp__browser_run_code_unsafe')).toEqual({ reason: '前哨的调研会话不能用这个工具' })
  })

  it('is left alone in 追问 chats and standard sessions, Outpost\'s or the user\'s', async () => {
    // A 追问 chat DSH reopens after a restart, which Outpost gives its tools again: the standard preset, no guard.
    host.store('outpost-followup-1a2b3c4d', { agentPreset: 'standard' })
    driver.rebind('outpost-followup-1a2b3c4d', [probe('outpost_read').tool])
    await host.sessionController.resolveAgent('outpost-followup-1a2b3c4d')
    expect(host.guards('outpost-followup-1a2b3c4d')).toEqual([])
    // The user's own sessions, and a standard one whatever its id: the preset decides.
    await host.spawn('chat-1', { agentPreset: 'standard' })
    await host.spawn('chat-2')
    await host.spawn('outpost-daily-odd', { agentPreset: 'standard' })
    for (const id of ['chat-1', 'chat-2', 'outpost-daily-odd']) {
      expect(host.guards(id), id).toEqual([])
      expect(host.denial(id, 'mcp__playwright-mcp__browser_run_code_unsafe'), id).toBeUndefined()
    }
  })

  it('tells a research agent by its preset, and by its id only when its session names no preset', () => {
    const agent = (id: string, agentPreset?: string) => ({ id, session: { header: agentPreset === undefined ? {} : { agentPreset } } }) as never
    expect(isResearchAgent(agent('outpost-daily-1', 'outpost-researcher'))).toBe(true)
    expect(isResearchAgent(agent('anything', 'outpost-researcher'))).toBe(true)
    // The preset without a browser is a research one too: the profile's own browser can reach it.
    expect(isResearchAgent(agent('outpost-daily-1', 'outpost-researcher-basic'))).toBe(true)
    expect(isResearchAgent(agent('anything', 'outpost-researcher-basic'))).toBe(true)
    expect(isResearchAgent(agent('outpost-daily-1', 'standard'))).toBe(false)
    expect(isResearchAgent(agent('outpost-verify-1'))).toBe(true) // no preset recorded: an Outpost session…
    expect(isResearchAgent(agent('outpost-followup-1'))).toBe(false) // …that is not a 追问 chat
    expect(isResearchAgent(agent('chat-1'))).toBe(false)
    expect(isResearchAgent({ id: 'outpost-baseline-1' } as never)).toBe(true) // no header to read at all
  })
})

describe('DshSessionDriver.nudge', () => {
  it('says one more thing in the session and waits for that round only', async () => {
    const first = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    host.assistant('outpost-daily-p1', { inputTokens: 100, outputTokens: 100 })
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await first
    const p = driver.nudge('outpost-daily-p1', '你还没调用 outpost_done，请调用它结束', signal)
    await host.started('outpost-daily-p1', 2)
    expect(host.sent('outpost-daily-p1').at(-1)).toMatchObject({ content: [{ type: 'text', text: '你还没调用 outpost_done，请调用它结束' }], source: { kind: 'dsh-outpost' } })
    expect([...host.tools('outpost-daily-p1').keys()]).toEqual(['outpost_done']) // the round's tools are still there
    host.assistant('outpost-daily-p1', { inputTokens: 7, outputTokens: 3 })
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    expect(await p).toEqual({ reason: 'completed', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0 } })
  })

  it('fails for a session that does not exist', async () => {
    await expect(driver.nudge('outpost-missing', '在吗', signal)).rejects.toThrow('outpost-missing')
  })
})

describe('DshSessionDriver.startInteractive', () => {
  it('opens the follow-up chat on DSH\'s standard preset with its tools and the first message, without waiting for an answer', async () => {
    const tools = researchTools('followup', { repo: {} as never, runId: 'r1', trackId: null, productId: 'p1', now: () => new Date(), icons: { fetch: async () => null }, onDone: () => {} })
    await driver.startInteractive({ sessionId: 'outpost-ask-1', title: '追问 · Cursor', prompt: '它的团队版多少钱？', tools, model: null })
    // The user's own chat (design §7.7): DSH's ordinary agent, not the research preset, which has only the web.
    // DSH makes and keeps it, as any chat of the user's: Outpost never lets it go (`release`).
    expect(host.sessionController.create).toHaveBeenCalledWith({ sessionId: 'outpost-ask-1', workspaceId: `ws-${workspaceDir}`, agentPreset: 'standard' })
    expect(host.agents.create).not.toHaveBeenCalled()
    expect(host.sessionController.rename).toHaveBeenCalledWith({ sessionId: 'outpost-ask-1', title: '追问 · Cursor' })
    expect([...host.tools('outpost-ask-1').keys()]).toEqual(['outpost_read'])
    expect(host.sent('outpost-ask-1')).toEqual([expect.objectContaining({ content: [{ type: 'text', text: '它的团队版多少钱？' }] })])
    expect(host.agent('outpost-ask-1').model.select).not.toHaveBeenCalled()
    expect(host.sessionPersistence.flush).toHaveBeenCalled()
  })

  it('selects the given model for an interactive session', async () => {
    const model = { provider: 'anthropic', model: 'claude-sonnet-4-5' }
    await driver.startInteractive({ sessionId: 'outpost-followup-1', title: '追问 · Cursor', prompt: '团队版多少钱？', tools: [probe('outpost_read').tool], model })
    const agent = host.agent('outpost-followup-1')
    expect(agent.model.select).toHaveBeenCalledExactlyOnceWith(model)
    // Chosen before the first message goes out, so that the first answer already comes from it.
    expect(agent.model.select.mock.invocationCallOrder[0]!).toBeLessThan(agent.followup.mock.invocationCallOrder[0]!)
    expect(host.sent('outpost-followup-1')).toHaveLength(1)

    // null: DSH's own choice for the session stands.
    await driver.startInteractive({ sessionId: 'outpost-followup-2', title: '追问 · Cursor', prompt: '团队版多少钱？', tools: [probe('outpost_read').tool], model: null })
    expect(host.agent('outpost-followup-2').model.select).not.toHaveBeenCalled()
  })
})

describe('DshSessionDriver.onChatUsage', () => {
  it('reports what a 追问 chat uses, reply by reply and search by search, for as long as the user keeps chatting', async () => {
    const seen: [string, unknown][] = []
    driver.onChatUsage((sessionId, usage) => { seen.push([sessionId, usage]) })
    await driver.startInteractive({ sessionId: 'outpost-followup-1', title: '追问 · Cursor', prompt: '团队版多少钱？', tools: [probe('outpost_read').tool], model: null })
    host.assistant('outpost-followup-1', { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5 })
    host.search('outpost-followup-1')
    host.assistant('outpost-followup-1', undefined) // a step that reported no usage: nothing to add
    host.assistant('outpost-followup-1', { inputTokens: 7, outputTokens: 3 }, 5) // a later turn: the user asked again
    expect(seen).toEqual([
      ['outpost-followup-1', { inputTokens: 105, outputTokens: 20, cacheReadTokens: 40 }],
      ['outpost-followup-1', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, searches: 1 }],
      ['outpost-followup-1', { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0 }],
    ])
  })

  it('reports nothing of research sessions (their runs count their own) or of sessions that are not Outpost\'s', async () => {
    const seen: string[] = []
    driver.onChatUsage(sessionId => { seen.push(sessionId) })
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    host.assistant('outpost-daily-p1', { inputTokens: 100, outputTokens: 20 })
    host.search('outpost-daily-p1')
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await p
    await host.spawn('chat-of-the-user')
    host.assistant('chat-of-the-user', { inputTokens: 100, outputTokens: 20 })
    expect(seen).toEqual([])
  })

  it('stops reporting once Outpost stops', async () => {
    const seen: string[] = []
    driver.onChatUsage(sessionId => { seen.push(sessionId) })
    await driver.startInteractive({ sessionId: 'outpost-followup-1', title: '追问 · Cursor', prompt: '团队版多少钱？', tools: [probe('outpost_read').tool], model: null })
    driver.close()
    host.assistant('outpost-followup-1', { inputTokens: 1, outputTokens: 1 })
    host.search('outpost-followup-1')
    expect(seen).toEqual([])
  })

  it('reports a chat given its tools again after a restart', async () => {
    const seen: string[] = []
    driver.onChatUsage(sessionId => { seen.push(sessionId) })
    await host.spawn('outpost-followup-live')
    driver.rebind('outpost-followup-live', [probe('outpost_read').tool])
    host.assistant('outpost-followup-live', { inputTokens: 1, outputTokens: 1 })
    expect(seen).toEqual(['outpost-followup-live'])
  })
})

describe('DshSessionDriver.rebind', () => {
  const followupTools = () => researchTools('followup', { repo: {} as never, runId: 'r1', trackId: null, productId: 'p1', now: () => new Date(), icons: { fetch: async () => null }, onDone: () => {} })

  it('gives a stored session its tools when DSH opens it again, without sending it anything', async () => {
    host.store('outpost-followup-1a2b3c4d') // a 追问 chat from before DSH restarted
    driver.rebind('outpost-followup-1a2b3c4d', followupTools())
    // Nothing is opened or said now: the session stays as the user left it.
    expect(host.sessionController.resolveAgent).not.toHaveBeenCalled()
    expect(host.sessionController.create).not.toHaveBeenCalled()

    await host.sessionController.resolveAgent('outpost-followup-1a2b3c4d') // the user opens it: DSH resumes the session
    expect([...host.tools('outpost-followup-1a2b3c4d').keys()]).toEqual(['outpost_read'])
    expect(host.sent('outpost-followup-1a2b3c4d')).toEqual([])
  })

  it('registers the tools at once on a session that is open now', async () => {
    await host.spawn('outpost-followup-live') // open in DSH while Outpost restarts
    expect(host.tools('outpost-followup-live').size).toBe(0)
    driver.rebind('outpost-followup-live', followupTools())
    expect([...host.tools('outpost-followup-live').keys()]).toEqual(['outpost_read'])
    expect(host.sent('outpost-followup-live')).toEqual([])
  })

  it('refuses a session id without the outpost- prefix', () => {
    expect(() => driver.rebind('chat-1', followupTools())).toThrow('outpost-')
  })
})

describe('DshSessionDriver.share', () => {
  it('offers the tool to every chat of the user\'s, 追问 included, but never to a research session', async () => {
    const { tool, calls } = probe('outpost_lookup', () => ({ product: { name: 'Muse' } }))
    driver.share(tool)
    const shared = host.profileTool('outpost_lookup')!
    expect(shared.description).toBe('outpost_lookup 的说明')
    await host.spawn('chat-1') // a chat the user opens in DSH
    await host.spawn('outpost-followup-1a2b3c4d')
    await host.spawn('outpost-daily-p1', { agentPreset: 'outpost-researcher' })
    await host.spawn('outpost-verify-p1') // no preset recorded: told by its id
    await host.spawn('a-chat-on-the-research-preset', { agentPreset: 'outpost-researcher-basic' })
    expect(await host.offers('chat-1', 'outpost_lookup')).toBe(true)
    expect(await host.offers('outpost-followup-1a2b3c4d', 'outpost_lookup')).toBe(true)
    expect(await host.offers('outpost-daily-p1', 'outpost_lookup')).toBe(false)
    expect(await host.offers('outpost-verify-p1', 'outpost_lookup')).toBe(false)
    expect(await host.offers('a-chat-on-the-research-preset', 'outpost_lookup')).toBe(false)
    // DSH calls it as any tool, and reads back its answer as JSON.
    const value = await shared.execute({ summary: 'Muse' }, { signal })
    expect(calls).toEqual([{ summary: 'Muse' }])
    expect(shared.output.render({}, value)).toEqual([{ type: 'text', text: '{"product":{"name":"Muse"}}' }])
    expect(shared.presentCall).toBeUndefined() // no title of its own: DSH's card names the tool
  })

  it('gives a call its own title on DSH\'s card, when the tool has one and the arguments parse', () => {
    const { tool } = probe('outpost_lookup')
    driver.share({ ...tool, title: args => `查前哨 · ${(args as { summary: string }).summary}` })
    const shared = host.profileTool('outpost_lookup')!
    expect(shared.presentCall!({ summary: 'Muse' })).toEqual({ card: 'generic', title: '查前哨 · Muse', kind: 'read' })
    expect(shared.presentCall!({ nothing: 1 })).toBeUndefined()
  })

  it('takes the tool back when asked, or when the driver closes, once', () => {
    const unshare = driver.share(probe('outpost_lookup').tool)
    unshare()
    expect(host.profileTool('outpost_lookup')).toBeUndefined()
    unshare() // again: nothing to do
    driver.share(probe('outpost_lookup').tool) // offered again, as when the user turns it back on
    driver.close()
    expect(host.profileTool('outpost_lookup')).toBeUndefined()
  })
})

describe('DshSessionDriver.close', () => {
  it('takes every tool it registered off the live agents, and registers none afterwards', async () => {
    await driver.startInteractive({ sessionId: 'outpost-followup-1', title: '追问 · Cursor', prompt: '团队版多少钱？', tools: [probe('outpost_read').tool], model: null })
    expect(host.tools('outpost-followup-1').size).toBe(1)
    driver.close()
    // Its tools answer from a store that is being closed; DSH must not call them any more.
    expect(host.tools('outpost-followup-1').size).toBe(0)
    await host.spawn('outpost-followup-1')
    expect(host.tools('outpost-followup-1').size).toBe(0)
  })
})

describe('DshSessionDriver.release', () => {
  it('release frees the live session without archiving it', async () => {
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await p
    const { handle } = host.created[0]!
    const live = host.agent('outpost-daily-p1')

    await driver.release('outpost-daily-p1')
    // The handle DSH gave for the agent is disposed: the live agent, and with it the browser it launched, is gone.
    expect(handle.dispose).toHaveBeenCalledOnce()
    expect(host.agents.get('outpost-daily-p1')).toBeUndefined()
    expect(host.tools('outpost-daily-p1').size).toBe(0)
    // Not archived, not deleted: the session stays where it was, and opening it in DSH later brings it back.
    expect(host.workspaceRegistry.archiveSession).not.toHaveBeenCalled()
    const reopened = await host.sessionController.resolveAgent('outpost-daily-p1')
    expect('agent' in reopened && reopened.agent).not.toBe(live)
    expect(host.agents.get('outpost-daily-p1')).toBeDefined()
    expect(host.tools('outpost-daily-p1').size).toBe(0) // its run is over: Outpost no longer serves it
    expect(host.sent('outpost-daily-p1')).toHaveLength(1) // nothing said to it

    // Once is enough; a second call, and one for a session Outpost never opened, do nothing.
    await driver.release('outpost-daily-p1')
    await driver.release('outpost-never-1')
    expect(handle.dispose).toHaveBeenCalledOnce()
  })

  it('leaves a 追问 chat alone, and only takes its tools back from a research session DSH resumed', async () => {
    await driver.startInteractive({ sessionId: 'outpost-followup-1', title: '追问 · Cursor', prompt: '团队版多少钱？', tools: [probe('outpost_read').tool], model: null })
    host.store('outpost-daily-old') // a research session from before a restart, which DSH opens again for its run
    const p = driver.run(specOf({ sessionId: 'outpost-daily-old' }), signal)
    await host.started('outpost-daily-old')
    host.turnEnd('outpost-daily-old', { kind: 'completed' })
    await p
    const warn = vi.spyOn(Object.getPrototypeOf(host.ctx.logger), 'warn').mockImplementation(() => {})
    try {
      await driver.release('outpost-followup-1')
      await driver.release('outpost-daily-old')
      expect(host.agents.get('outpost-followup-1')).toBeDefined()
      expect([...host.tools('outpost-followup-1').keys()]).toEqual(['outpost_read'])
      expect(host.agents.get('outpost-daily-old')).toBeDefined()
      expect(host.tools('outpost-daily-old').size).toBe(0)
      // DSH holds the agent it resumed and offers no way to let it go: said in the log, with the session's id.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('%s'), 'outpost-daily-old')
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), 'outpost-followup-1')
    } finally {
      warn.mockRestore()
    }
  })

  it('never throws, even when taking the session\'s tools back fails', async () => {
    const first = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await first
    // The next round's tool is registered with a disposer that throws when it is taken back.
    const register = (host.agent('outpost-daily-p1').ctx as unknown as { tools: { register: ReturnType<typeof vi.fn> } }).tools.register
    register.mockImplementationOnce(() => () => { throw new Error('the tool registry is gone') })
    const second = driver.run(specOf({ tools: [probe('outpost_submit_facts').tool] }), signal)
    await host.started('outpost-daily-p1', 2)
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await second
    const warn = vi.spyOn(Object.getPrototypeOf(host.ctx.logger), 'warn').mockImplementation(() => {})
    try {
      await expect(driver.release('outpost-daily-p1')).resolves.toBeUndefined()
      expect(host.created[0]!.handle.dispose).toHaveBeenCalledOnce() // the live agent goes all the same
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('%s'), 'outpost-daily-p1', expect.stringContaining('the tool registry is gone'))
    } finally {
      warn.mockRestore()
    }
  })

  it('logs a release that fails instead of throwing it', async () => {
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await p
    host.created[0]!.handle.dispose.mockRejectedValueOnce(new Error('the browser would not close'))
    const warn = vi.spyOn(Object.getPrototypeOf(host.ctx.logger), 'warn').mockImplementation(() => {})
    try {
      await expect(driver.release('outpost-daily-p1')).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('%s'), 'outpost-daily-p1', expect.stringContaining('the browser would not close'))
    } finally {
      warn.mockRestore()
    }
  })
})

describe('DshSessionDriver.archive', () => {
  it('archives the session, stopping what it still does, and lets go of its tools', async () => {
    const p = driver.run(specOf(), signal)
    await host.started('outpost-daily-p1')
    host.turnEnd('outpost-daily-p1', { kind: 'completed' })
    await p
    await driver.archive('outpost-daily-p1')
    expect(host.workspaceRegistry.archiveSession).toHaveBeenCalledWith('outpost-daily-p1', { stopActivity: true })
    expect(host.tools('outpost-daily-p1').size).toBe(0)
    await host.spawn('outpost-daily-p1') // opened again later: Outpost no longer serves it
    expect(host.tools('outpost-daily-p1').size).toBe(0)
  })
})

describe('toolParameters', () => {
  type Schema = { type?: string; required?: string[]; properties?: Record<string, { type?: unknown; anyOf?: { type?: string }[] }> }
  const params = (name: string) => {
    const tool = ['recommend', 'baseline', 'daily', 'verify'].flatMap(kind =>
      researchTools(kind as 'daily', { repo: {} as never, runId: 'r1', trackId: 't1', productId: 'p1', now: () => new Date(), icons: { fetch: async () => null }, onDone: () => {} }))
      .find(t => t.name === name)!
    return toolParameters(tool.schema) as Schema
  }
  const allowsNull = (node: { type?: unknown; anyOf?: { type?: string }[] } | undefined) =>
    (Array.isArray(node?.type) && node.type.includes('null')) || !!node?.anyOf?.some(branch => branch.type === 'null')

  it('describes the arguments the model may send, as the tool accepts them', () => {
    const card = params('outpost_submit_card')
    expect(card.type).toBe('object')
    expect(card.required).not.toContain('inferenceQuotes') // may be left out
    expect(card.required).toEqual(expect.arrayContaining(['dimension', 'summary', 'bullets', 'body', 'sources']))
    const candidate = params('outpost_submit_candidate')
    expect(candidate.required).not.toContain('officialUrl')
    expect(candidate.required).not.toContain('iconUrl')
    expect(allowsNull(candidate.properties!.officialUrl)).toBe(true)
    const check = params('outpost_report_check')
    expect(check.required).toEqual(expect.arrayContaining(['sourceId', 'openedVia', 'quoteFound', 'supportsClaim', 'official']))
    expect(check.required).not.toContain('syndicationGroup')
    expect(allowsNull(check.properties!.quoteFound)).toBe(true)
    expect(allowsNull(check.properties!.official)).toBe(true)
    expect(allowsNull(check.properties!.syndicationGroup)).toBe(true)
    expect(params('outpost_read_pending')).toMatchObject({ type: 'object', properties: {} })
  })

  it('is plain JSON that DSH can copy without loss', () => {
    // DSH's `snapshotJsonValue` (used when it projects tool schemas, e.g. for code-execution mode) refuses an object with a
    // non-enumerable or symbol key, a prototype other than Object's, or an undefined value; zod adds a hidden `~standard`.
    const problems = (value: unknown, path: string): string[] => {
      if (value === undefined) return [`${path} is undefined`]
      if (value === null || typeof value !== 'object') return []
      const own = Reflect.ownKeys(value).filter(key => !(Array.isArray(value) && key === 'length'))
      const hidden = own.filter(key => typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key)).map(key => `${path}.${String(key)} is hidden`)
      const proto = Object.getPrototypeOf(value)
      const odd = proto === Object.prototype || proto === Array.prototype ? [] : [`${path} has an unusual prototype`]
      return [...hidden, ...odd, ...Object.entries(value).flatMap(([key, child]) => problems(child, `${path}.${key}`))]
    }
    for (const name of ['outpost_submit_candidate', 'outpost_submit_card', 'outpost_submit_finding', 'outpost_report_check', 'outpost_add_source', 'outpost_done', 'outpost_read'])
      expect(problems(params(name), name)).toEqual([])
  })

  it('does not require a field that has a default', () => {
    const schema = z.object({ summary: z.string(), tags: z.array(z.string()).default([]) })
    expect(toolParameters(schema)).toMatchObject({ type: 'object', required: ['summary'], properties: { tags: { type: 'array', default: [] } } })
  })
})
