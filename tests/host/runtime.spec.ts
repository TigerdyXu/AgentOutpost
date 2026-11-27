import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, DEFAULT_PRICES, type OutpostConfig } from '../../src/config.ts'
import type { ModelRef } from '../../src/core/models.ts'
import { STOPPED_ERROR } from '../../src/host/jobs/runner.ts'
import { lockedMessage, Runtime } from '../../src/host/runtime.ts'
import * as outpost from '../../src/index.ts'
import { lockDataDir, openDb } from '../../src/store/db.ts'
import { Repo } from '../../src/store/repo.ts'
import { apiHost, type ApiHost, type CapturedRoute } from '../fixtures/api-host.ts'
import { dshHost } from '../fixtures/dsh-context.ts'
import { flush, gate } from '../fixtures/fake-driver.ts'

/** Every `onCompromised` the runtime hands the lock, so a test can report a lost lock the way proper-lockfile would. */
const compromised = vi.hoisted(() => [] as ((error: Error) => void)[])
vi.mock('../../src/store/db.ts', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/store/db.ts')>()
  return {
    ...real,
    lockDataDir: (dir: string, onCompromised?: (error: Error) => void) => {
      if (onCompromised) compromised.push(onCompromised)
      return real.lockDataDir(dir, onCompromised)
    },
  }
})

let host: ApiHost
let runtime: Runtime | undefined
beforeEach(() => {
  host = apiHost()
  compromised.length = 0
})
afterEach(async () => {
  await runtime?.stop()
  runtime = undefined
  host.cleanup()
})

/** Writes rows straight into the data directory's database, as an earlier run of Outpost left them. */
function seed(write: (repo: Repo) => void, on: ApiHost = host) {
  mkdirSync(on.dataDir, { recursive: true })
  const db = openDb(join(on.dataDir, 'outpost.sqlite'))
  try { write(new Repo(db, () => on.clock.clock.now())) } finally { db.close() }
}
/** Reads the database after the runtime let go of it. */
function inspect<T>(read: (repo: Repo) => T): T {
  const db = openDb(join(host.dataDir, 'outpost.sqlite'))
  try { return read(new Repo(db)) } finally { db.close() }
}
const product = (repo: Repo, id: string, status: 'tracking' | 'baselining' = 'tracking') =>
  repo.upsertProduct({ id, name: id === 'p1' ? 'Cursor' : 'Windsurf', company: 'Anysphere', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: [], status, dailyBudgetYuan: null })

describe('apply', () => {
  /** A DSH host with every service Outpost injects, the Web server capturing the route. */
  function dsh() {
    const fake = dshHost()
    const routes: CapturedRoute[] = []
    fake.ctx.reflect.provide('webServer', { register: (route: CapturedRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } })
    for (const name of ['tools', 'systemPrompt', 'web']) fake.ctx.reflect.provide(name, {})
    return { ...fake, routes }
  }
  async function get(route: CapturedRoute, path: string) {
    const req = Object.assign(Readable.from([]), { method: 'GET', url: `/outpost/api/${path}`, headers: {} })
    const sent = { status: 0, body: '' }
    const res = { writeHead: (status: number) => { sent.status = status; return res }, end: (chunk?: string) => { sent.body = chunk ?? '' } }
    await route.handler(req, res)
    return { status: sent.status, json: () => JSON.parse(sent.body) as unknown }
  }

  it('registers the routes once loaded, and its cleanup stops everything and releases the data directory', async () => {
    const dsh1 = dsh()
    const fiber = dsh1.ctx.plugin(outpost, { dataDir: host.dataDir })
    await fiber
    expect(dsh1.routes).toHaveLength(1)
    expect(dsh1.routes[0]).toMatchObject({ kind: 'prefix', path: '/outpost' })
    expect(await get(dsh1.routes[0]!, 'health').then(r => [r.status, r.json()])).toEqual([200, { ok: true }])
    const state = await get(dsh1.routes[0]!, 'state')
    expect(state.status).toBe(200)
    expect(state.json()).toMatchObject({ tracks: [], todayUnread: 0, browserAvailable: false })
    expect(() => lockDataDir(host.dataDir)).toThrow() // held while it runs

    await fiber.dispose()
    expect(dsh1.routes).toHaveLength(0)
    lockDataDir(host.dataDir)() // free again: taken and given back

    // And it loads again on the same directory, as after a restart of DSH.
    const dsh2 = dsh()
    const again = dsh2.ctx.plugin(outpost, { dataDir: host.dataDir })
    await again
    expect(dsh2.routes).toHaveLength(1)
    await again.dispose()
  })

  it('fails to load, in plain words, on a data directory another Outpost holds', async () => {
    const release = lockDataDir(host.dataDir)
    try {
      const fake = dsh()
      await expect(fake.ctx.plugin(outpost, { dataDir: host.dataDir })).rejects.toThrow(`数据目录被另一个前哨进程占用：${host.dataDir}`)
      expect(fake.routes).toHaveLength(0)
    } finally {
      release()
    }
  })
})

describe('Runtime', () => {
  it('refuses a data directory another Outpost holds with a clear message, and leaves the lock to its holder', () => {
    const release = lockDataDir(host.dataDir)
    expect(() => host.create()).toThrow(lockedMessage(host.dataDir))
    expect(lockedMessage(host.dataDir)).toBe(`数据目录被另一个前哨进程占用：${host.dataDir}`)
    expect(() => lockDataDir(host.dataDir)).toThrow() // still held by the first
    release()
  })

  it('makes the data directory and its icons and workspace folders private, also when they already exist', () => {
    for (const dir of [host.dataDir, join(host.dataDir, 'icons'), join(host.dataDir, 'workspace')]) {
      mkdirSync(dir, { recursive: true })
      chmodSync(dir, 0o755)
    }
    runtime = host.create()
    for (const dir of [host.dataDir, join(host.dataDir, 'icons'), join(host.dataDir, 'workspace')])
      expect(statSync(dir).mode & 0o777, dir).toBe(0o700)
    expect(statSync(join(host.dataDir, 'outpost.sqlite')).mode & 0o777).toBe(0o600)
  })

  it('logs a lock it could not keep instead of taking the host down', () => {
    runtime = host.create()
    expect(compromised).toHaveLength(1)
    expect(() => compromised[0]!(Object.assign(new Error('Unable to update lock within the stale threshold'), { code: 'ECOMPROMISED' }))).not.toThrow()
    expect(host.logger.error).toHaveBeenCalledOnce()
    expect(host.logger.error.mock.calls[0]!.map(String).join(' ')).toContain('Unable to update lock within the stale threshold')
  })

  it('reads the settings that may change while it runs on every use', async () => {
    let budget = 20
    const config = Config({ dataDir: host.dataDir })
    const live = { ...config, dailyBudgetYuan: { get: () => budget }, model: { get: () => undefined } } as unknown as OutpostConfig
    const other = apiHost({ config: () => live })
    try {
      const rt = other.create()
      expect(rt.settings()).toMatchObject({ runTime: '08:00', maxParallel: 3, dailyBudgetYuan: 20, sessionTimeoutMin: 30, model: null })
      budget = 5
      expect(rt.settings().dailyBudgetYuan).toBe(5)
      await rt.stop()
    } finally {
      other.cleanup()
    }
  })

  it('marks the runs an earlier Outpost left running as interrupted, and keeps finished ones', async () => {
    let ids: Record<string, string> = {}
    seed(repo => {
      const running = repo.createRun({ kind: 'daily', date: '2026-11-24', trackId: null, productId: 'p1' })
      repo.updateRun(running.id, { status: 'running', startedAt: '2026-11-24T08:00:00.000Z' })
      const queued = repo.createRun({ kind: 'recommend', date: '2026-11-25', trackId: 't1', productId: null })
      const done = repo.createRun({ kind: 'daily', date: '2026-11-24', trackId: null, productId: 'p2' })
      repo.updateRun(done.id, { status: 'done', startedAt: '2026-11-24T08:00:00.000Z', endedAt: '2026-11-24T08:10:00.000Z' })
      ids = { running: running.id, queued: queued.id, done: done.id }
    })
    runtime = host.create()
    runtime.start()
    const run = (id: string) => runtime!.repo.getRun(id)!
    expect(run(ids.running!)).toMatchObject({ status: 'failed', error: STOPPED_ERROR, endedAt: host.clock.clock.now().toISOString() })
    expect(run(ids.queued!)).toMatchObject({ status: 'failed', error: STOPPED_ERROR })
    expect(run(ids.done!)).toMatchObject({ status: 'done', error: null, endedAt: '2026-11-24T08:10:00.000Z' })
  })

  it('gives the follow-up chats of the last 30 days their outpost_read again on start', async () => {
    seed(repo => {
      product(repo, 'p1')
      const followup = (date: string, sessionId: string, status: 'done' | 'failed') => {
        const run = repo.createRun({ kind: 'followup', date, trackId: null, productId: 'p1' })
        repo.updateRun(run.id, { status, sessionId, startedAt: `${date}T09:00:00.000Z`, endedAt: `${date}T09:00:01.000Z` })
      }
      followup('2026-11-20', 'outpost-followup-recent1', 'done')
      followup('2026-10-26', 'outpost-followup-recent2', 'done') // 30 days before today
      followup('2026-10-20', 'outpost-followup-tooold1', 'done')
      followup('2026-11-21', 'outpost-followup-failed1', 'failed') // never opened
    })
    runtime = host.create()
    runtime.start()
    expect(host.driver.rebound.map(r => r.sessionId)).toEqual(['outpost-followup-recent1', 'outpost-followup-recent2'])
    const tools = host.driver.rebound[0]!.tools
    expect(tools.map(t => t.name)).toEqual(['outpost_read'])
    const read = await tools[0]!.execute({}) as { product: { name: string } }
    expect(read.product.name).toBe('Cursor') // the product of that chat
  })

  it('logs a follow-up chat it could not re-bind, and starts anyway', () => {
    seed(repo => {
      product(repo, 'p1')
      const run = repo.createRun({ kind: 'followup', date: '2026-11-20', trackId: null, productId: 'p1' })
      repo.updateRun(run.id, { status: 'done', sessionId: 'outpost-followup-broken1' })
    })
    host.driver.rebind = () => { throw new Error('tool "outpost_read" is already registered') }
    runtime = host.create()
    runtime.start()
    expect(host.routes).toHaveLength(1)
    expect(host.logger.warn.mock.calls.flat().map(String).join(' ')).toContain('outpost-followup-broken1')
  })

  it('wires the scheduler: the day catches up on start and re-baselines a product stuck in 建档中 through the baseline job', async () => {
    const other = apiHost({ now: '2026-11-25T09:00' })
    try {
      seed(repo => {
        const track = repo.createTrack({ name: 'AI 编程助手', brief: '', dimensions: [{ key: 'positioning', label: '定位' }], status: 'active' })
        product(repo, 'p1', 'baselining')
        repo.linkProduct(track.id, 'p1')
      }, other)
      const rt = other.create()
      rt.start()
      await vi.waitFor(() => { expect(other.driver.runs.map(r => r.title)).toContain('前哨 · Cursor 建档') })
      await rt.stop()
    } finally {
      other.cleanup()
    }
  })

  it('wires the scheduler\'s log to the DSH logger', async () => {
    const config = Config({ dataDir: host.dataDir })
    const odd = { ...config, runTime: { get: () => '25:00' } } as unknown as OutpostConfig
    const other = apiHost({ config: () => odd })
    try {
      const rt = other.create()
      rt.start()
      expect(other.logger.warn.mock.calls.flat().map(String).join(' ')).toContain('runTime "25:00" is not HH:MM')
      await rt.stop()
    } finally {
      other.cleanup()
    }
  })

  it('picks up a changed run time, which is volatile, within a minute: today runs at the new time, not at the old one', async () => {
    let runTime = '08:00'
    // `runTime` read through a reference, as DSH's volatile fields are: the test changes it while the runtime runs.
    const other = apiHost({ config: dataDir => ({ ...Config({ dataDir }), runTime: { get: () => runTime } }) as unknown as OutpostConfig })
    try {
      seed(repo => {
        const track = repo.createTrack({ name: 'AI 编程助手', brief: '', dimensions: [{ key: 'positioning', label: '定位' }], status: 'active' })
        product(repo, 'p1')
        repo.linkProduct(track.id, 'p1')
        repo.addCardVersion({ productId: 'p1', dimension: 'positioning', version: 1, summary: '编辑器', bullets: ['基于 VS Code'], body: '编辑器[1]', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-20T00:00:00.000Z' })
      }, other)
      const rt = other.create()
      rt.start()
      const daily = () => rt.repo.listRuns('2026-11-25').filter(run => run.kind === 'daily')
      expect(other.clock.pending()).toEqual([new Date(2026, 10, 25, 8, 0)])
      runTime = '07:30'
      other.clock.set('2026-11-25T07:01') // the minute's look
      expect(other.clock.pending()).toEqual([new Date(2026, 10, 25, 7, 30)])
      await flush(20)
      expect(daily()).toHaveLength(0) // nothing ran at the change itself
      other.clock.set('2026-11-25T07:30')
      await vi.waitFor(() => { expect(daily()).toHaveLength(1) })
      expect(other.clock.pending()).toEqual([new Date(2026, 10, 26, 7, 30)])
      await rt.stop()
    } finally {
      other.cleanup()
    }
  })

  it('stop does not wait for the brief\'s model call: the gist being written is given up at once', async () => {
    seed(repo => {
      product(repo, 'p1')
      const run = repo.createRun({ kind: 'daily', date: '2026-11-25', trackId: null, productId: 'p1' })
      repo.updateRun(run.id, { status: 'done' })
      repo.addFinding({
        productId: 'p1', runId: run.id, headline: 'Cursor 后台 Agent 正式上线', why: '值得看', importance: 'major', claimKind: 'self', sourceIds: [], status: 'verified',
        statusNote: null, unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: 'k', verifiedOn: '2026-11-25',
      })
    })
    let asked: AbortSignal | undefined
    host.complete.mockImplementation((_req, signal) => {
      asked = signal
      return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true }) })
    })
    runtime = host.create()
    runtime.start()
    void runtime.scheduler.rewriteBrief('2026-11-25')
    await vi.waitFor(() => { expect(asked).toBeDefined() })

    const rt = runtime
    runtime = undefined
    await rt.stop() // with the 2-minute limit alone, this would wait (and the test time out)
    expect(asked!.aborted).toBe(true)
    expect(inspect(repo => repo.runsOfDate('2026-11-25', 'synthesize'))[0]).toMatchObject({ status: 'failed', error: STOPPED_ERROR })
  })

  it('stop ends the sessions in flight, then closes the store, takes its tools back and releases the lock', async () => {
    const held = gate()
    host.driver.script['outpost-recommend-'] = async round => {
      await Promise.race([held.promise, new Promise(resolve => round.signal.addEventListener('abort', resolve))])
      return { reason: 'timeout', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } }
    }
    runtime = host.create()
    runtime.start()
    const created = await host.call('POST', 'tracks', { name: 'AI 编程助手', brief: '', extraDimensions: [] })
    expect(created.status).toBe(200)
    await flush()
    expect(host.driver.runs).toHaveLength(1) // the recommendation is running

    const rt = runtime
    runtime = undefined
    await rt.stop()
    expect(host.routes).toHaveLength(0)
    expect(host.driver.closed).toBe(true)
    expect(() => rt.repo.listTracks()).toThrow() // closed
    lockDataDir(host.dataDir)() // released
    const batch = inspect(repo => repo.getRun(created.json<{ batchId: string }>().batchId))
    expect(batch).toMatchObject({ status: 'failed', error: STOPPED_ERROR })
    await rt.stop() // twice is harmless
  })

  it('says the browser fallback is on when the research preset composes an active browser provider', () => {
    runtime = host.create()
    const module = (moduleName: string) => ({ moduleName, useHostBase: true })
    const compositions = vi.fn((): { id: string; modules: { moduleName: string; useHostBase: boolean }[]; leakedServices: string[] }[] => [])
    delete host.services.agentPresets
    expect(runtime.browserAvailable()).toBe(false) // no preset registry at all
    host.services.agentPresets = { inspectCompositions: compositions }
    expect(runtime.browserAvailable()).toBe(false) // the research preset does not compose (it is broken, say)

    // Another preset's browser is not the research sessions'.
    compositions.mockReturnValue([{ id: 'standard', modules: [module('@deepseek-ai/dsh-browser-use'), module('@deepseek-ai/dsh-experimental-browser-use-playwright-mcp')], leakedServices: [] }])
    expect(runtime.browserAvailable()).toBe(false)
    // The research preset with the browser-use service but no provider active (its row disabled or still waiting).
    compositions.mockReturnValue([{ id: 'outpost-researcher', modules: [module('@deepseek-ai/dsh-tool-web'), module('@deepseek-ai/dsh-browser-use')], leakedServices: [] }])
    expect(runtime.browserAvailable()).toBe(false)
    // cordis.patch.yml as shipped: the provider is active inside the research preset.
    compositions.mockReturnValue([{ id: 'outpost-researcher', modules: [module('@deepseek-ai/dsh-tool-web'), module('@deepseek-ai/dsh-browser-use'), module('@deepseek-ai/dsh-experimental-browser-use-playwright-mcp')], leakedServices: [] }])
    expect(runtime.browserAvailable()).toBe(true)
    expect(compositions).toHaveBeenCalledWith() // every retained revision: a revision live sessions still hold counts too

    // A registry that cannot say is not taken for a browser.
    compositions.mockImplementation(() => { throw new Error('registry stopping') })
    expect(runtime.browserAvailable()).toBe(false)
    // A provider registered for the whole profile still counts, as before.
    host.services.browserUse = { providerName: 'chrome-devtools-mcp' }
    expect(runtime.browserAvailable()).toBe(true)
  })

  it('reads a Playwright browser for the whole profile beside the preset\'s own as a conflict that stops research, not as on', async () => {
    runtime = host.create()
    const research = (...moduleNames: string[]) => [{ id: 'outpost-researcher', modules: moduleNames.map(moduleName => ({ moduleName, useHostBase: true })), leakedServices: [] }]
    const resolve = vi.fn(async (id: string): Promise<{ id: string; broken?: string }> => ({ id }))
    const compositions = vi.fn(() => research('@deepseek-ai/dsh-browser-use', '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'))
    host.services.agentPresets = { resolve, inspectCompositions: compositions }
    expect(runtime.browserAvailable()).toBe(true)
    expect(await runtime.researchProblem()).toBeNull()

    // Both would start an MCP server named playwright-mcp for a research session; DSH refuses the second.
    host.services.browserUse = { providerName: 'playwright-mcp' }
    expect(runtime.browserAvailable()).toBe(false)
    expect(await runtime.researchProblem()).toContain('playwright-mcp')
    // Another browser for the whole profile clashes with nothing.
    host.services.browserUse = { providerName: 'chrome-devtools-mcp' }
    expect(runtime.browserAvailable()).toBe(true)
    expect(await runtime.researchProblem()).toBeNull()
    // A research preset overridden without its browser: the profile's Playwright is the one research sessions use.
    host.services.browserUse = { providerName: 'playwright-mcp' }
    compositions.mockReturnValue(research('@deepseek-ai/dsh-tool-web'))
    expect(runtime.browserAvailable()).toBe(true)
    expect(await runtime.researchProblem()).toBeNull()

    // DSH's own diagnostic of the preset (a row that did not load), and a preset DSH does not know.
    resolve.mockResolvedValueOnce({ id: 'outpost-researcher', broken: 'browser-use-playwright: Cannot find package' })
    expect(await runtime.researchProblem()).toContain('Cannot find package')
    resolve.mockRejectedValueOnce(new Error('Unknown agent preset: outpost-researcher'))
    expect(await runtime.researchProblem()).toContain('Unknown agent preset')
    expect(resolve).toHaveBeenCalledWith('outpost-researcher')
  })
})

describe('models', () => {
  const A: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const FREE = { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0 }
  /** A session plan with no tools: the agent ends without `outpost_done`, is nudged once, and the run is done. */
  const plan = () => ({ title: '前哨 · 测试', prompt: '看看有什么新动态', tools: () => [] })
  const kindOf = (sessionId: string) => sessionId.split('-')[1]

  /**
   * A runtime on `on` whose brief model call goes to DSH (`ctx.llm.stream`, answering one sentence), as when DSH loads
   * the plugin, and its model call's mock.
   */
  function onDsh(on: ApiHost) {
    const stream = vi.fn((_options: Record<string, unknown>) => (async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '今天一条重要更新。' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    Object.assign(on.ctx.llm, { stream })
    return { rt: new Runtime(on.ctx as never, on.config, { driver: on.driver, clock: on.clock.clock, icons: on.icons }), stream }
  }
  /** Asks for each of the four roles once: a daily run, a check, the brief's model call, and a 追问 chat. */
  async function useEveryRole(on: ApiHost, rt: Runtime) {
    await rt.runner.session('daily', {}, plan)
    await rt.runner.session('verify', {}, plan)
    await rt.model.complete({ system: '写一句话', user: '今天的发现' }, new AbortController().signal)
    product(rt.repo, 'p1')
    const run = rt.repo.createRun({ kind: 'daily', date: '2026-11-25', trackId: null, productId: 'p1' })
    const finding = rt.repo.addFinding({
      productId: 'p1', runId: run.id, headline: 'Cursor 后台 Agent 正式上线', why: '值得看', importance: 'major', claimKind: 'self', sourceIds: [], status: 'verified',
      statusNote: null, unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: `k-${run.id}`, verifiedOn: '2026-11-25',
    })
    expect((await on.call('POST', 'followup', { findingId: finding.id })).status).toBe(200)
  }

  it('old configuration with only model uses it for all four roles', async () => {
    const other = apiHost({ config: dataDir => Config({ dataDir, model: A }) })
    const { rt, stream } = onDsh(other)
    try {
      rt.start()
      expect(rt.settings()).toMatchObject({ model: A, verifyModel: null, briefModel: null, followupModel: null })

      await useEveryRole(other, rt)

      expect(other.driver.runs.map(s => [kindOf(s.sessionId), s.model])).toEqual([['daily', A], ['verify', A]])
      expect(stream).toHaveBeenCalledOnce()
      expect(stream).toHaveBeenCalledWith(expect.objectContaining({ provider: A.provider, model: A.model }))
      expect(other.agentDefaultModel.currentSelection).not.toHaveBeenCalled() // the brief did not fall back on DSH's default
      expect(other.driver.interactive.map(s => s.model)).toEqual([A])
    } finally {
      await rt.stop()
      other.cleanup()
    }
  })

  it('gives each role the model chosen for it, read anew on each use', async () => {
    const models: Record<'model' | 'verifyModel' | 'briefModel' | 'followupModel', ModelRef | null | undefined> = {
      model: A, verifyModel: undefined, briefModel: undefined, followupModel: undefined,
    }
    const config = Config({ dataDir: host.dataDir })
    const live = { ...config, ...Object.fromEntries(Object.keys(models).map(key => [key, { get: () => models[key as keyof typeof models] }])) } as unknown as OutpostConfig
    const other = apiHost({ config: () => live })
    const { rt, stream } = onDsh(other)
    try {
      rt.start()
      // Chosen while Outpost runs: the next use takes it, without a restart.
      models.verifyModel = { provider: 'deepseek-official', model: 'deepseek-flash' }
      models.briefModel = { provider: 'anthropic', model: 'claude-sonnet-4-5' }
      models.followupModel = { provider: 'ollama', model: 'qwen3:8b' }

      await useEveryRole(other, rt)

      expect(other.driver.runs.map(s => [kindOf(s.sessionId), s.model])).toEqual([['daily', A], ['verify', models.verifyModel]])
      expect(stream).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-4-5' }))
      expect(other.driver.interactive.map(s => s.model)).toEqual([models.followupModel])
    } finally {
      await rt.stop()
      other.cleanup()
    }
  })

  it('decides how an unset model is billed by DSH\'s default model, and calls it metered when DSH cannot say', async () => {
    const other = apiHost()
    other.ctx.llm.listProviders.mockReturnValue([{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'box', name: 'Ollama (local)' }])
    other.agentDefaultModel.currentSelection.mockReturnValue({ provider: 'box', model: 'qwen3:8b' })
    const rt = other.create()
    try {
      const { billingFor } = rt.settings()
      expect(billingFor(null)).toBe('local')
      expect(billingFor({ provider: 'anthropic', model: 'claude-sonnet-4-5' })).toBe('subscription')
      expect(billingFor({ provider: 'deepseek-official', model: 'deepseek-flash' })).toBe('metered')
      other.agentDefaultModel.currentSelection.mockReturnValue({ provider: 'deepseek-official', model: 'deepseek-flash' })
      expect(billingFor(null)).toBe('metered')
      other.agentDefaultModel.currentSelection.mockImplementation(() => { throw new Error('no default model') })
      expect(billingFor(null)).toBe('metered') // the budget still holds it
    } finally {
      await rt.stop()
      other.cleanup()
    }
  })

  it('adds what a 追问 chat uses to its run, priced at the time of each reply on the follow-up model', async () => {
    // A Friday at 11:00 Beijing time: DeepSeek's peak; the chat goes on past 12:00, into the off-peak hours.
    const other = apiHost({ now: new Date('2026-11-27T11:00:00+08:00'), config: dataDir => Config({ dataDir, model: { provider: 'deepseek-official', model: 'deepseek-flash' } }) })
    other.ctx.llm.listProviders.mockReturnValue([{ id: 'deepseek-official', name: 'DeepSeek' }])
    const rt = other.create()
    try {
      rt.start()
      const chat = rt.repo.createRun({ kind: 'followup', date: '2026-11-27', trackId: null, productId: null })
      rt.repo.updateRun(chat.id, { status: 'done', sessionId: 'outpost-followup-abcd1234' })

      other.driver.chatUses('outpost-followup-abcd1234', { inputTokens: 1_000_000 }) // peak: ¥2
      other.driver.chatUses('outpost-followup-abcd1234', { searches: 1 }) // peak: 8,000 × 2 + 800 × 8 → ¥0.0224
      other.clock.set(new Date('2026-11-27T12:30:00+08:00'))
      other.driver.chatUses('outpost-followup-abcd1234', { outputTokens: 1_000_000 }) // off-peak: ¥8 / 2
      other.driver.chatUses('outpost-research-zzz', { inputTokens: 1_000_000 }) // not a chat of a run: ignored

      expect(rt.repo.getRun(chat.id)).toMatchObject({
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, searches: 1 },
        costYuan: 6.0224,
        status: 'done',
      })
      expect(rt.repo.spentOn('2026-11-27')).toBe(6.0224) // it counts towards the day's spending
    } finally {
      await rt.stop()
      other.cleanup()
    }
  })

  it('prices by the provider of the model, DSH\'s default model when none is chosen, and halves DeepSeek off-peak', async () => {
    const other = apiHost({ config: dataDir => Config({ dataDir, prices: { inputPerMTok: 3 } }) })
    other.ctx.llm.listProviders.mockReturnValue([{ id: 'deepseek-official', name: 'DeepSeek' }, { id: 'box', name: 'Ollama (local)' }, { id: 'anthropic', name: 'Anthropic' }])
    other.agentDefaultModel.currentSelection.mockReturnValue({ provider: 'box', model: 'qwen3:8b' })
    const rt = other.create()
    // A Friday: 10:00 is DeepSeek's peak, 08:00 its off-peak (Beijing time).
    const PEAK = new Date('2026-11-27T10:00:00+08:00')
    const OFF = new Date('2026-11-27T08:00:00+08:00')
    try {
      const table = { ...DEFAULT_PRICES, inputPerMTok: 3 }
      const half = { inputPerMTok: 1.5, outputPerMTok: DEFAULT_PRICES.outputPerMTok / 2, cacheReadPerMTok: DEFAULT_PRICES.cacheReadPerMTok / 2 }
      const { pricesOf } = rt.settings()
      expect(pricesOf(null, PEAK)).toEqual(FREE) // the default model is local, as its provider's name says
      expect(pricesOf({ provider: 'deepseek-official', model: 'deepseek-flash' }, PEAK)).toEqual(table)
      expect(pricesOf({ provider: 'deepseek-official', model: 'deepseek-flash' }, OFF)).toEqual(half)
      expect(pricesOf({ provider: 'anthropic', model: 'claude-sonnet-4-5' }, OFF)).toEqual(FREE)
      expect(pricesOf({ provider: 'box', model: 'qwen3:8b' }, OFF)).toEqual(FREE)
      // another metered provider: estimated with the table, at any hour (the off-peak discount is DeepSeek's)
      expect(pricesOf({ provider: 'zai', model: 'glm-5' }, PEAK)).toEqual(table)
      expect(pricesOf({ provider: 'zai', model: 'glm-5' }, OFF)).toEqual(table)

      other.agentDefaultModel.currentSelection.mockReturnValue({ provider: 'deepseek-official', model: 'deepseek-flash' })
      expect(pricesOf(null, PEAK)).toEqual(table) // the default is read on each use
      expect(pricesOf(null, OFF)).toEqual(half)
      // DSH cannot say which model is its default: estimated with the table (DeepSeek's prices), so the budget still holds.
      other.agentDefaultModel.currentSelection.mockImplementation(() => { throw new Error('no default model') })
      expect(pricesOf(null, PEAK)).toEqual(table)
      expect(pricesOf(null, OFF)).toEqual(half)
    } finally {
      await rt.stop()
      other.cleanup()
    }
  })
})
