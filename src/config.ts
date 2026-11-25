/** Plugin configuration of the `outpost` entry. Volatile fields are read on each use, so changing them needs no restart. */
// Lets the emitted declaration of Config name Schemastery's `Dict` through this package's own dependency (TS2883 otherwise).
import type {} from '@deepseek-ai/cosmokit'
import s from '@deepseek-ai/schemastery'

/**
 * Default unit prices, yuan per million tokens, of DeepSeek's default model `deepseek-flash` (DeepSeek-V4.1-Flash), from
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing as read on 2026-11-25. These are the peak-hour prices (weekdays
 * 9:00–12:00 and 14:00–18:00 Beijing time); off-peak prices are half, so a run that starts at 08:00 usually costs less.
 * Every cost the panel shows from them is labelled 「估算」.
 */
export const DEFAULT_PRICES = { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 } as const

const price = (value: number, description: string) => s.number().min(0).default(value).description(description)

export const Config = s.object({
  dataDir: s.string().pattern(/^\//).required()
    .description('Directory for the database (outpost.sqlite), product icons (icons/) and research working files (workspace/). Absolute path.'),
  runTime: s.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00')
    .description('Local time of the daily update, HH:MM (00:00 to 23:59).').volatile(),
  maxParallel: s.number().min(1).max(8).step(1).default(3)
    .description('Products researched at the same time.').volatile(),
  dailyBudgetYuan: s.number().min(0).default(20)
    .description('Estimated spend per day, in yuan, after which remaining products wait for the next day.').volatile(),
  sessionTimeoutMin: s.number().min(1).default(30)
    .description('Time limit of one research session, in minutes.').volatile(),
  // Absent or null: research sessions use the user's default model of DSH. Schemastery keeps an absent value absent (a null
  // default is no default), so readers treat `undefined` like `null`.
  model: s.union([
    s.const(null),
    s.object({ provider: s.string().required(), model: s.string().required() }),
  ]).description('Model of research sessions; empty uses the default model of DSH.').volatile(),
  prices: s.object({
    inputPerMTok: price(DEFAULT_PRICES.inputPerMTok, 'Input tokens (cache miss), yuan per million.'),
    outputPerMTok: price(DEFAULT_PRICES.outputPerMTok, 'Output tokens, yuan per million.'),
    cacheReadPerMTok: price(DEFAULT_PRICES.cacheReadPerMTok, 'Input tokens read from cache, yuan per million.'),
  }).default({})
    .description('Unit prices used to estimate spend.').volatile(),
})
export type OutpostConfig = ReturnType<typeof Config>
