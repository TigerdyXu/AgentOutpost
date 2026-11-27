import { describe, expect, it } from 'vitest'
import { billingOf, modelFor, onDeepSeek, type ModelSettings } from '../../src/core/models.ts'

const A = { provider: 'deepseek-official', model: 'deepseek-flash' }
const B = { provider: 'ollama', model: 'qwen3:8b' }
const C = { provider: 'anthropic', model: 'claude-sonnet-4-5' }
const none: ModelSettings = { model: null, verifyModel: null, briefModel: null, followupModel: null }

describe('modelFor', () => {
  it('uses the role\'s own model, else the research model, else null (the default model of DSH)', () => {
    expect(modelFor('verify', { ...none, model: A })).toBe(A)
    expect(modelFor('followup', { ...none, model: A, followupModel: B })).toBe(B)
    expect(modelFor('brief', { ...none, model: A, briefModel: C })).toBe(C)
    expect(modelFor('brief', { ...none, model: A, verifyModel: B, followupModel: C })).toBe(A) // another role's model is not its own
    // Research has no field of its own besides `model`: the others never stand in for it.
    expect(modelFor('research', { model: A, verifyModel: B, briefModel: B, followupModel: B })).toBe(A)
    expect(modelFor('research', { ...none, verifyModel: B, briefModel: B, followupModel: B })).toBeNull()
    expect(modelFor('followup', { ...none, followupModel: C })).toBe(C)
    for (const role of ['research', 'verify', 'brief', 'followup'] as const) expect(modelFor(role, none), role).toBeNull()
  })

  it('treats a field the configuration leaves out like null', () => {
    // Schemastery keeps an absent value absent: a configuration written before these fields existed has only `model`.
    const old = { model: A } as unknown as ModelSettings
    for (const role of ['research', 'verify', 'brief', 'followup'] as const) expect(modelFor(role, old), role).toBe(A)
    expect(modelFor('verify', {} as ModelSettings)).toBeNull()
  })
})

describe('billingOf', () => {
  it('counts a local service as local, Anthropic as the subscription, and every other provider as metered', () => {
    expect(billingOf('ollama')).toBe('local')
    expect(billingOf('my-box', 'Ollama (local)')).toBe('local')
    expect(billingOf('anthropic')).toBe('subscription')
    expect(billingOf('deepseek-official')).toBe('metered')
    expect(billingOf('zai')).toBe('metered')
  })

  it('knows a local service by its id or its name, whatever the case', () => {
    for (const id of ['Ollama', 'lmstudio', 'lm-studio', 'LM-Studio', 'llama.cpp', 'llamacpp', 'local-openai'])
      expect(billingOf(id), id).toBe('local')
    for (const name of ['LMStudio', 'llama.cpp server', 'My Local Box'])
      expect(billingOf('box-1', name), name).toBe('local')
    expect(billingOf('deepseek-official', 'DeepSeek')).toBe('metered')
  })

  it('takes only the provider id anthropic for the subscription', () => {
    expect(billingOf('anthropic', 'Anthropic')).toBe('subscription')
    expect(billingOf('openrouter', 'Anthropic via OpenRouter')).toBe('metered')
    expect(billingOf('anthropic-bedrock')).toBe('metered')
  })
})

describe('onDeepSeek', () => {
  it('tells DeepSeek\'s own providers (whose prices halve off-peak) from the rest', () => {
    for (const id of ['deepseek-official', 'deepseek', 'DeepSeek-account']) expect(onDeepSeek(id), id).toBe(true)
    for (const id of ['zai', 'ollama', 'anthropic', 'openrouter']) expect(onDeepSeek(id), id).toBe(false)
  })
})
