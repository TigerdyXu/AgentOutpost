import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DshModelClient, listModelGroups } from '../../src/host/dsh-model.ts'
import { dshHost, type DshHost } from '../fixtures/dsh-context.ts'

let host: DshHost
let signal: AbortSignal
beforeEach(() => {
  host = dshHost()
  signal = new AbortController().signal
})

/** A model answer as DSH streams it: some reasoning, two text blocks, the usage and the finish. */
const answer = [
  { type: 'block-start', index: 0, blockType: 'reasoning' },
  { type: 'reasoning-delta', index: 0, text: '先想一想' },
  { type: 'block-end', index: 0, block: { type: 'reasoning', text: '先想一想' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: '今天 3 个产品' },
  { type: 'text-delta', index: 1, text: '有动静，' },
  { type: 'block-end', index: 1, block: { type: 'text', text: '今天 3 个产品有动静，' } },
  { type: 'block-start', index: 2, blockType: 'text' },
  { type: 'text-delta', index: 2, text: '最大的是 Cursor 涨价。' },
  { type: 'block-end', index: 2, block: { type: 'text', text: '最大的是 Cursor 涨价。' } },
  { type: 'usage', usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 800, totalTokens: 2080 } },
  { type: 'finish', reason: { kind: 'stop' } },
]

describe('DshModelClient', () => {
  it('sends the system prompt and the user text to the chosen model, and returns the text with its usage', async () => {
    host.respond(answer)
    const client = new DshModelClient(host.ctx, () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro' }))
    const result = await client.complete({ system: '你是前哨的编辑', user: '写今日一句话' }, signal)
    expect(host.llm.stream).toHaveBeenCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-pro', system: '你是前哨的编辑',
      messages: [{ role: 'user', content: [{ type: 'text', text: '写今日一句话' }] }], signal,
    })
    expect(host.agentDefaultModel.currentSelection).not.toHaveBeenCalled()
    // Only the text blocks, in order; the reasoning stays out. Input counts are disjoint in DSH (see dsh-sessions.spec).
    expect(result).toEqual({ text: '今天 3 个产品有动静，最大的是 Cursor 涨价。', usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 800 } })
  })

  it('uses the default model when none is configured', async () => {
    host.respond(answer)
    host.agentDefaultModel.currentSelection.mockReturnValue({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } as never)
    const client = new DshModelClient(host.ctx, () => null)
    expect((await client.complete({ system: 's', user: 'u' }, signal)).text).toBe('今天 3 个产品有动静，最大的是 Cursor 涨价。')
    expect(host.agentDefaultModel.currentSelection).toHaveBeenCalled()
    expect(host.llm.stream).toHaveBeenCalledWith(expect.objectContaining({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' }))
  })

  it('keeps the text of a block that never closed, and counts nothing when the model reported no usage', async () => {
    host.respond([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '写到一半' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    const client = new DshModelClient(host.ctx, () => null)
    expect(await client.complete({ system: 's', user: 'u' }, signal)).toEqual({ text: '写到一半', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } })
  })

  it('throws the failure of a call that ended in an error or was aborted', async () => {
    const client = new DshModelClient(host.ctx, () => null)
    host.respond([{ type: 'finish', reason: { kind: 'error', failure: { message: 'HTTP 401: invalid api key', code: 'AUTH' } } }])
    await expect(client.complete({ system: 's', user: 'u' }, signal)).rejects.toThrow('HTTP 401: invalid api key')
    host.respond([{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'ABORTED' } } }])
    await expect(client.complete({ system: 's', user: 'u' }, signal)).rejects.toThrow('aborted')
  })

  it('stops waiting for a model that ignores the abort signal, and lets go of its stream', async () => {
    // A provider that hangs and never looks at the signal must not hold the caller (the brief queue) forever.
    const close = vi.fn(async () => ({ done: true as const, value: undefined }))
    host.llm.stream.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => {}), return: close }),
    }) as never)
    const client = new DshModelClient(host.ctx, () => null)
    const controller = new AbortController()
    const call = client.complete({ system: 's', user: 'u' }, controller.signal)
    const outcome = vi.fn()
    call.then(outcome, outcome)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(outcome).not.toHaveBeenCalled()

    controller.abort(new Error('time is up'))
    await expect(call).rejects.toThrow('模型调用已中止')
    expect(close).toHaveBeenCalledOnce()
  })

  it('does not call the model at all once the signal has aborted', async () => {
    const client = new DshModelClient(host.ctx, () => null)
    await expect(client.complete({ system: 's', user: 'u' }, AbortSignal.abort())).rejects.toThrow('模型调用已中止')
    expect(host.llm.stream).not.toHaveBeenCalled()
  })

  it('keeps no abort listener once the answer is in', async () => {
    host.respond(answer)
    const client = new DshModelClient(host.ctx, () => null)
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await client.complete({ system: 's', user: 'u' }, controller.signal)
    controller.abort() // after the fact: nothing left to reject, no unhandled rejection
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), expect.anything())
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1])
  })
})

describe('listModelGroups', () => {
  afterEach(() => { vi.useRealTimers() })

  /** DSH's model directory: one provider answers, one fails (Ollama not running), one never answers. */
  const directory = () => ({
    listProviders: vi.fn(() => [{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'my-box', name: 'Ollama (local)' }, { id: 'anthropic', name: 'Anthropic' }]),
    listModels: vi.fn(async (provider: string) => {
      if (provider === 'my-box') throw new Error('connect ECONNREFUSED 127.0.0.1:11434')
      if (provider === 'anthropic') return new Promise<never>(() => {})
      return [
        { provider, id: 'deepseek-flash', name: 'DeepSeek Flash', description: '快而便宜', badge: { text: '默认', tone: 'neutral' as const } },
        { provider, id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ]
    }),
  })

  it('lists each provider\'s models and marks a provider that fails or hangs', async () => {
    vi.useFakeTimers()
    const llm = directory()
    let groups: Awaited<ReturnType<typeof listModelGroups>> | undefined
    void listModelGroups(llm).then(result => { groups = result })

    // Each provider has 5 seconds, all at the same time: one that hangs holds up the list no longer than that.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(groups).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(groups).toEqual([
      {
        provider: 'deepseek-official', name: 'DeepSeek', billing: 'metered', error: null,
        models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }],
      },
      { provider: 'my-box', name: 'Ollama (local)', billing: 'local', models: [], error: '读取失败' },
      { provider: 'anthropic', name: 'Anthropic', billing: 'subscription', models: [], error: '读取失败' },
    ])
    expect(llm.listModels.mock.calls.map(([provider]) => provider)).toEqual(['deepseek-official', 'my-box', 'anthropic'])
    expect(vi.getTimerCount()).toBe(0) // no time limit left running
  })

  it('answers as soon as every provider has, and takes a time limit', async () => {
    const llm = directory()
    llm.listProviders.mockReturnValue([{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'anthropic', name: 'Anthropic' }])
    const started = Date.now()
    const groups = await listModelGroups(llm, 50)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(groups.map(g => [g.provider, g.models.length, g.error])).toEqual([['deepseek-official', 2, null], ['anthropic', 0, '读取失败']])

    llm.listProviders.mockReturnValue([{ id: 'deepseek-official', name: 'DeepSeek' }])
    vi.useFakeTimers()
    const quick = listModelGroups(llm)
    await vi.advanceTimersByTimeAsync(0)
    expect(await quick).toHaveLength(1) // no provider hung: no waiting for the limit
    expect(vi.getTimerCount()).toBe(0)
  })
})
