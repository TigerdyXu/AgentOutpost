import type { Billing } from './models.ts'
import type { Usage } from './types.ts'

/** Yuan per million tokens. */
export interface PriceTable { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number }

const FREE: PriceTable = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0 }

/** The prices of a model billed as `billing`: `table` for a metered one, nothing for a local or subscription one. */
export function pricesFor(billing: Billing, table: PriceTable): PriceTable {
  return billing === 'metered' ? table : { ...FREE }
}

/** Cost in yuan of one usage record, rounded to 4 decimals. `inputTokens` is the input that missed the cache. */
export function costOf(u: Usage, p: PriceTable): number {
  const yuan = (u.inputTokens * p.inputPerMTok + u.outputTokens * p.outputPerMTok + u.cacheReadTokens * p.cacheReadPerMTok) / 1_000_000
  return Math.round(yuan * 10_000) / 10_000
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
