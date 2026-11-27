/**
 * Which model each of Outpost's uses runs on, and how a model's provider is billed. Research (recommendations,
 * baselines, daily updates) runs on `model`; the check, the brief's gist and a 追问 chat each have a model of their own,
 * which, left unset, is the research model; and with no research model either, DSH's default model (null).
 */

/** One model of one DSH provider, as `ctx.llm` routes it. */
export interface ModelRef { provider: string; model: string }

/** What a model is used for. Recommendations, baselines and daily updates are all `research`. */
export type ModelRole = 'research' | 'verify' | 'brief' | 'followup'

/** The configured models (the plugin configuration's fields of the same names). null: not chosen. */
export interface ModelSettings {
  /** Research; null uses DSH's default model. */
  model: ModelRef | null
  /** The check; null uses the research model. */
  verifyModel: ModelRef | null
  /** The brief's one-sentence gist; null uses the research model. */
  briefModel: ModelRef | null
  /** A 追问 chat; null uses the research model. */
  followupModel: ModelRef | null
}

const OWN: Record<Exclude<ModelRole, 'research'>, Exclude<keyof ModelSettings, 'model'>> = {
  verify: 'verifyModel', brief: 'briefModel', followup: 'followupModel',
}

/**
 * The model `role` runs on: its own, else the research model, else null (DSH's default model). A field the configuration
 * leaves out (`undefined`, as Schemastery keeps it) counts as null.
 */
export function modelFor(role: ModelRole, s: ModelSettings): ModelRef | null {
  return (role === 'research' ? null : s[OWN[role]]) ?? s.model ?? null
}

/** How a model's use is paid: by the token (Outpost's price table), or not by the token at all (counted as ¥0). */
export type Billing = 'metered' | 'local' | 'subscription'

const LOCAL = /ollama|lm-?studio|llama\.?cpp|local/i

/**
 * How a provider is billed: a local service (its id or name says Ollama, LM Studio, llama.cpp or local) costs nothing;
 * `anthropic` is DSH's Claude Pro/Max sign-in, paid by the subscription; every other provider is estimated with
 * Outpost's price table. (Anthropic with a pay-as-you-go API key is counted as the subscription too, so Outpost does not
 * count that spending; Settings says so.)
 * @param provider - the provider's id, as DSH routes it.
 * @param providerName - its display name, from `ctx.llm.listProviders()`, when known.
 */
/** Whether `provider` is one of DeepSeek's own routes, whose prices are half in DeepSeek's off-peak hours (`pricesAt`). */
export function onDeepSeek(provider: string): boolean {
  return /deepseek/i.test(provider)
}

export function billingOf(provider: string, providerName?: string): Billing {
  if (LOCAL.test(provider) || (providerName !== undefined && LOCAL.test(providerName))) return 'local'
  if (provider === 'anthropic') return 'subscription'
  return 'metered'
}
