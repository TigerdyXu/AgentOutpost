import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Config, DEFAULT_DATA_DIR } from '../src/config.ts'

// Only the computed path is checked: nothing here makes the directory (a Runtime would), so the real home is not touched.
it('keeps the data in ~/.outpost/data when the profile names no dataDir, as the installer does', () => {
  expect(DEFAULT_DATA_DIR).toBe(join(homedir(), '.outpost', 'data'))
  expect(DEFAULT_DATA_DIR.startsWith('/')).toBe(true)
  expect(Config({}).dataDir).toBe(DEFAULT_DATA_DIR)
  expect(Config({ dataDir: undefined }).dataDir).toBe(DEFAULT_DATA_DIR)
})

it('uses a dataDir the profile names instead, and requires it to be absolute', () => {
  expect(Config({ dataDir: '/srv/outpost' }).dataDir).toBe('/srv/outpost')
  expect(() => Config({ dataDir: 'relative/dir' })).toThrow()
  expect(() => Config({ dataDir: '~/outpost' })).toThrow() // Outpost does not expand ~; the default is already absolute
})

it('fills the defaults behind volatile references', () => {
  const config = Config({ dataDir: '/srv/outpost' })
  expect(config.runTime.get()).toBe('08:00')
  expect(config.maxParallel.get()).toBe(3)
  expect(config.dailyBudgetYuan.get()).toBe(20)
  expect(config.sessionTimeoutMin.get()).toBe(30)
  // No model chosen: research sessions use the user's default model of DSH.
  expect(config.model.get() ?? null).toBeNull()
  const prices = config.prices.get()
  expect(Object.keys(prices).sort()).toEqual(['cacheReadPerMTok', 'inputPerMTok', 'outputPerMTok'])
  expect(prices.inputPerMTok).toBeGreaterThan(0)
  expect(prices.outputPerMTok).toBeGreaterThan(prices.inputPerMTok)
  expect(prices.cacheReadPerMTok).toBeLessThan(prices.inputPerMTok)
})

it('keeps a chosen model and rejects out-of-range values', () => {
  expect(Config({ dataDir: '/d', model: null }).model.get()).toBeNull()
  expect(Config({ dataDir: '/d', model: { provider: 'deepseek', model: 'deepseek-v4-pro' } }).model.get()).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
  expect(Config({ dataDir: '/d', runTime: '21:30' }).runTime.get()).toBe('21:30')
  expect(() => Config({ dataDir: '/d', runTime: '8:00' })).toThrow()
  // Only real times of day: the scheduler's calendar throws on anything else.
  expect(Config({ dataDir: '/d', runTime: '00:00' }).runTime.get()).toBe('00:00')
  expect(Config({ dataDir: '/d', runTime: '23:59' }).runTime.get()).toBe('23:59')
  for (const runTime of ['24:00', '99:99', '23:60', '12:5', ' 08:00'])
    expect(() => Config({ dataDir: '/d', runTime }), runTime).toThrow()
  expect(() => Config({ dataDir: '/d', maxParallel: 9 })).toThrow()
  expect(() => Config({ dataDir: '/d', maxParallel: 0 })).toThrow()
})

it('keeps a model per role: absent until chosen, null, or a whole { provider, model }; half of one is refused', () => {
  const config = Config({ dataDir: '/d', model: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  for (const key of ['verifyModel', 'briefModel', 'followupModel'] as const) {
    // Absent or null: the same model as research.
    expect(config[key].get(), key).toBeUndefined()
    expect(Config({ dataDir: '/d', [key]: null })[key].get(), key).toBeNull()
    expect(Config({ dataDir: '/d', [key]: { provider: 'ollama', model: 'qwen3:8b' } })[key].get(), key).toEqual({ provider: 'ollama', model: 'qwen3:8b' })
    expect(() => Config({ dataDir: '/d', [key]: { provider: 'ollama' } } as never), key).toThrow()
    expect(() => Config({ dataDir: '/d', [key]: { model: 'qwen3:8b' } } as never), key).toThrow()
  }
})
