import type { Billing } from './models.ts'
import type { Usage } from './types.ts'

/** Yuan per million tokens. */
export interface PriceTable { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number }

const FREE: PriceTable = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0 }

/** The prices of a model billed as `billing`: `table` for a metered one, nothing for a local or subscription one. */
export function pricesFor(billing: Billing, table: PriceTable): PriceTable {
  return billing === 'metered' ? table : { ...FREE }
}

/**
 * What one web search on a DeepSeek route is taken to use. DSH sends each search as a model call of its own
 * (`web/deepseek-search-llm-request`) and drops the `usage` DeepSeek returns, so the tokens are an estimate: the search
 * results the model reads (nearly all uncached) and the cited answer it writes. DeepSeek charges no per-search fee for this
 * route since 2026-11-18, only these tokens. The middle of the range worked out on 2026-11-27 (3,000/300 to 20,000/2,000).
 */
export const SEARCH_TOKENS = { inputTokens: 8000, outputTokens: 800 } as const

/**
 * Cost in yuan of one usage record, rounded to 4 decimals. `inputTokens` is the input that missed the cache; each search
 * adds `SEARCH_TOKENS` of uncached input and output.
 */
export function costOf(u: Usage, p: PriceTable): number {
  const searches = u.searches ?? 0
  const input = u.inputTokens + searches * SEARCH_TOKENS.inputTokens
  const output = u.outputTokens + searches * SEARCH_TOKENS.outputTokens
  const yuan = (input * p.inputPerMTok + output * p.outputPerMTok + u.cacheReadTokens * p.cacheReadPerMTok) / 1_000_000
  return Math.round(yuan * 10_000) / 10_000
}

/** Beijing time is UTC+8 all year (no daylight saving). */
const BEIJING_OFFSET_MS = 8 * 3_600_000

/**
 * Whether `at` falls in DeepSeek's off-peak hours: outside weekdays 9:00–12:00 and 14:00–18:00 Beijing time, read in
 * Beijing time whatever the machine's time zone. Public holidays are not known here and count as weekdays.
 */
export function offPeak(at: Date): boolean {
  const beijing = new Date(at.getTime() + BEIJING_OFFSET_MS)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) return true
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  const peak = (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
  return !peak
}

/**
 * The prices that apply at `at`: DeepSeek's (`onDeepSeek`) are half off-peak; `table` holds the peak prices. Other
 * providers keep `table` at any hour.
 */
export function pricesAt(table: PriceTable, at: Date, onDeepSeek: boolean): PriceTable {
  if (!onDeepSeek || !offPeak(at)) return { ...table }
  return { inputPerMTok: table.inputPerMTok / 2, outputPerMTok: table.outputPerMTok / 2, cacheReadPerMTok: table.cacheReadPerMTok / 2 }
}

/**
 * Whether one more piece of work may start. A budget counts as used up once spending has reached it. The daily total is
 * checked first; a product with no budget of its own (`productBudget: null`) is limited by the daily total only.
 */
export function canSpend(a: { spentToday: number; dailyBudget: number; productSpentToday: number; productBudget: number | null }): { ok: true } | { ok: false; reason: string } {
  if (a.spentToday >= a.dailyBudget) return { ok: false, reason: '今日总预算已用完' }
  if (a.productBudget !== null && a.productSpentToday >= a.productBudget) return { ok: false, reason: '该产品今日预算已用完' }
  return { ok: true }
}
