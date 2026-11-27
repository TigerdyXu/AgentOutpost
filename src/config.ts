/** Plugin configuration of the `outpost` entry. Volatile fields are read on each use, so changing them needs no restart. */
// Lets the emitted declaration of Config name Schemastery's `Dict` through this package's own dependency (TS2883 otherwise).
import type {} from '@deepseek-ai/cosmokit'
import s from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where Outpost keeps its data when the profile names no `dataDir`: `~/.outpost/data`, the directory install.sh has always
 * written into the profile. A plain `dsh plugin add` (npm, the plugin market, a Git URL) applies only the package's own
 * cordis.patch.yml, whose `outpost` row carries no configuration, so without a default the plugin would refuse to start
 * there. It is absolute (Outpost does not expand `~`), read from the home directory of the process DSH runs in.
 */
export const DEFAULT_DATA_DIR = join(homedir(), '.outpost', 'data')

/**
 * Default unit prices, yuan per million tokens, of DeepSeek's default model `deepseek-flash` (DeepSeek-V4.1-Flash), from
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing as read on 2026-11-25. These are the peak-hour prices (weekdays
 * 9:00–12:00 and 14:00–18:00 Beijing time); off-peak prices are half, and Outpost halves them itself for a DeepSeek route
 * (`pricesAt`, src/core/cost.ts). Every cost the panel shows from them is labelled 「估算」.
 */
export const DEFAULT_PRICES = { inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.04 } as const

const price = (value: number, description: string) => s.number().min(0).default(value).description(description)
/**
 * A model of DSH, or null. Absent or null means: research uses DSH's default model, and the other roles use the research
 * model. Schemastery keeps an absent value absent (a null default is no default), so readers treat `undefined` like `null`.
 */
const modelRef = (description: string) => s.union([
  s.const(null),
  s.object({ provider: s.string().required(), model: s.string().required() }),
]).description(description).volatile()

export const Config = s.object({
  dataDir: s.string().pattern(/^\//).default(DEFAULT_DATA_DIR)
    .description('Directory for the database (outpost.sqlite), product icons (icons/) and research working files (workspace/). Absolute path; ~/.outpost/data when left out.'),
  runTime: s.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).default('08:00')
    .description('Local time of the daily update, HH:MM (00:00 to 23:59).').volatile(),
  maxParallel: s.number().min(1).max(8).step(1).default(3)
    .description('Products researched at the same time.').volatile(),
  dailyBudgetYuan: s.number().min(0).default(20)
    .description('Estimated spend per day, in yuan, after which remaining products wait for the next day.').volatile(),
  sessionTimeoutMin: s.number().min(1).default(30)
    .description('Time limit of one research session, in minutes.').volatile(),
  // The models of the four roles (src/core/models.ts). `model` is research's, as before these roles existed.
  model: modelRef('Model of research (recommendations, baselines, daily updates); empty uses the default model of DSH.'),
  verifyModel: modelRef('Model of the check; empty uses the research model.'),
  briefModel: modelRef('Model that writes the brief\'s one-sentence gist; empty uses the research model.'),
  followupModel: modelRef('Model of a 追问 chat; empty uses the research model.'),
  prices: s.object({
    inputPerMTok: price(DEFAULT_PRICES.inputPerMTok, 'Input tokens (cache miss), yuan per million.'),
    outputPerMTok: price(DEFAULT_PRICES.outputPerMTok, 'Output tokens, yuan per million.'),
    cacheReadPerMTok: price(DEFAULT_PRICES.cacheReadPerMTok, 'Input tokens read from cache, yuan per million.'),
  }).default({})
    .description('Unit prices used to estimate spend.').volatile(),
})
export type OutpostConfig = ReturnType<typeof Config>
