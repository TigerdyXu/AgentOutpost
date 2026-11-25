/**
 * `ModelClient` on DSH: one model call through `ctx.llm.stream`, for writing that needs no tools or session. The model is
 * the one Outpost is configured with, else the user's default model of DSH. Only DSH types are imported; the text is
 * collected from the stream's chunks here rather than with dsh-llm's `BlockAssembler`, a value import.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { FinishReason, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Usage } from '../core/types.ts'
import { addUsage } from './dsh-sessions.ts'
import type { ModelClient } from './ports.ts'

export class DshModelClient implements ModelClient {
  /**
   * @param ctx - the plugin's Context, which provides `llm` and `agentDefaultModel`.
   * @param pick - the configured model, read on each call; null uses DSH's default model.
   */
  constructor(private readonly ctx: Context, private readonly pick: () => { provider: string; model: string } | null) {}

  async complete(req: { system: string; user: string }, signal: AbortSignal): Promise<{ text: string; usage: Usage }> {
    const picked = this.pick()
    const route = picked ? { provider: picked.provider, model: picked.model } : this.ctx.agentDefaultModel.currentSelection()
    /** Text of each text block, in the order the blocks began; a closed block's final text wins over its deltas. */
    const texts = new Map<number, string>()
    const closed = new Set<number>()
    let reported: TokenUsage | undefined
    let finish: FinishReason | undefined
    const stream = this.ctx.llm.stream({
      provider: route.provider, model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
      system: req.system, messages: [{ role: 'user', content: [{ type: 'text', text: req.user }] }], signal,
    })
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'block-start':
          if (chunk.blockType === 'text' && !texts.has(chunk.index)) texts.set(chunk.index, '')
          break
        case 'text-delta':
          if (!closed.has(chunk.index)) texts.set(chunk.index, (texts.get(chunk.index) ?? '') + chunk.text)
          break
        case 'block-end':
          if (chunk.block.type === 'text' && !closed.has(chunk.index)) { texts.set(chunk.index, chunk.block.text); closed.add(chunk.index) }
          break
        case 'usage': reported = chunk.usage; break
        case 'finish': finish = chunk.reason; break
        default: break
      }
    }
    // DSH turns every failure of the call, a cancellation included, into the final chunk.
    if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(finish.failure.message, { cause: finish.failure })
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    addUsage(usage, reported)
    return { text: [...texts.values()].join(''), usage }
  }
}
