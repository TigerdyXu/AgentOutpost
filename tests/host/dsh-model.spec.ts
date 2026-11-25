import { beforeEach, describe, expect, it } from 'vitest'
import { DshModelClient } from '../../src/host/dsh-model.ts'
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
})
