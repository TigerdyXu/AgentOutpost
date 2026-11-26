import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, type OutpostConfig } from '../../src/config.ts'
import { STOPPED_ERROR } from '../../src/host/jobs/runner.ts'
import { lockedMessage, type Runtime } from '../../src/host/runtime.ts'
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
})
