import { describe, expect, it } from 'vitest'
import { canSpend, costOf, pricesFor, type PriceTable } from '../../src/core/cost.ts'

// Yuan per million tokens.
const prices: PriceTable = { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5 }
const usage = (inputTokens: number, outputTokens: number, cacheReadTokens: number) => ({ inputTokens, outputTokens, cacheReadTokens })

describe('costOf', () => {
  it('charges 1,000,000 uncached input tokens at exactly inputPerMTok', () => {
    expect(costOf(usage(1_000_000, 0, 0), prices)).toBe(prices.inputPerMTok)
  })

  it('charges output and cache-read tokens at their own prices', () => {
    expect(costOf(usage(0, 1_000_000, 0), prices)).toBe(prices.outputPerMTok)
    expect(costOf(usage(0, 0, 1_000_000), prices)).toBe(prices.cacheReadPerMTok)
  })

  it('adds the three parts together', () => {
    // 0.5M * 2 + 0.25M * 8 + 2M * 0.5 = 1 + 2 + 1
    expect(costOf(usage(500_000, 250_000, 2_000_000), prices)).toBe(4)
  })

  it('costs nothing when nothing was used', () => {
    expect(costOf(usage(0, 0, 0), prices)).toBe(0)
  })

  it('rounds to 4 decimal places', () => {
    // 1,234 * 2 / 1e6 = 0.002468
    expect(costOf(usage(1_234, 0, 0), prices)).toBe(0.0025)
    // 12,345 * 8 / 1e6 = 0.09876
    expect(costOf(usage(0, 12_345, 0), prices)).toBe(0.0988)
    // 100,000 * 0.5 / 1e6 = 0.05 stays as it is
    expect(costOf(usage(0, 0, 100_000), prices)).toBe(0.05)
  })

  it('rounds the total once, not each part', () => {
    const p: PriceTable = { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 1 }
    // Each part is 0.00003 (0 when rounded alone); together 0.00009 -> 0.0001.
    expect(costOf(usage(30, 30, 30), p)).toBe(0.0001)
  })

  it('returns a clean decimal, without floating-point tails', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floating point.
    expect(costOf(usage(1_000_000, 1_000_000, 0), { inputPerMTok: 0.1, outputPerMTok: 0.2, cacheReadPerMTok: 0 })).toBe(0.3)
  })
})

describe('canSpend', () => {
  const base = { spentToday: 1, dailyBudget: 5, productSpentToday: 0.5, productBudget: 2 }

  it('allows spending while both budgets have room', () => {
    expect(canSpend(base)).toEqual({ ok: true })
  })

  it('refuses when the daily total is used up', () => {
    expect(canSpend({ ...base, spentToday: 5 })).toEqual({ ok: false, reason: '今日总预算已用完' })
    expect(canSpend({ ...base, spentToday: 7.25 })).toEqual({ ok: false, reason: '今日总预算已用完' })
  })

  it('refuses when the product budget is used up', () => {
    expect(canSpend({ ...base, productSpentToday: 2 })).toEqual({ ok: false, reason: '该产品今日预算已用完' })
    expect(canSpend({ ...base, productSpentToday: 3.1 })).toEqual({ ok: false, reason: '该产品今日预算已用完' })
  })

  it('puts no limit on a product without a budget of its own', () => {
    expect(canSpend({ ...base, productBudget: null, productSpentToday: 4.9 })).toEqual({ ok: true })
    // ... but the daily total still applies to it.
    expect(canSpend({ ...base, productBudget: null, spentToday: 5 })).toEqual({ ok: false, reason: '今日总预算已用完' })
  })

  it('names the daily total first when both are used up', () => {
    expect(canSpend({ spentToday: 5, dailyBudget: 5, productSpentToday: 2, productBudget: 2 })).toEqual({ ok: false, reason: '今日总预算已用完' })
  })

  it('a budget of 0 allows nothing', () => {
    expect(canSpend({ ...base, spentToday: 0, dailyBudget: 0 })).toEqual({ ok: false, reason: '今日总预算已用完' })
    expect(canSpend({ ...base, productSpentToday: 0, productBudget: 0 })).toEqual({ ok: false, reason: '该产品今日预算已用完' })
  })
})

describe('pricesFor', () => {
  it('prices a local or subscription model at nothing, and a metered one by the table as it is', () => {
    const none = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0 }
    expect(pricesFor('local', prices)).toEqual(none)
    expect(pricesFor('subscription', prices)).toEqual(none)
    expect(pricesFor('metered', prices)).toEqual(prices)
    expect(costOf(usage(1_000_000, 1_000_000, 1_000_000), pricesFor('local', prices))).toBe(0)
  })
})
