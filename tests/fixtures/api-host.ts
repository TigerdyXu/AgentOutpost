/**
 * Outpost's runtime on a fake host, for the route tests: a temporary data directory, a Context whose `webServer.register`
 * captures the `/outpost` route and whose logger records what it is told, the scripted `FakeDriver`, a model answering
 * what the test says, a fake icon downloader and a manual clock (07:00 on 2026-11-25 by default, before the daily run,
 * so starting the runtime starts no day). `call` sends one request through the captured route, as the Web server would.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { vi } from 'vitest'
import { Config, type OutpostConfig } from '../../src/config.ts'
import type { ModelClient } from '../../src/host/ports.ts'
import { Runtime } from '../../src/host/runtime.ts'
import { FakeDriver, usage } from './fake-driver.ts'
import { manualClock, type When } from './manual-clock.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
export interface CapturedRoute { kind: string; path: string; handler: Handler; auth?: unknown }

export interface Reply {
  status: number
  headers: Record<string, string>
  body: Buffer
  json<T = any>(): T
}

export function apiHost(options: { now?: When; config?: (dataDir: string) => OutpostConfig } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-api-'))
  const dataDir = join(dir, 'data')
  const routes: CapturedRoute[] = []
  const line = () => vi.fn<(format: unknown, ...params: unknown[]) => void>()
  const logger = { info: line(), warn: line(), error: line(), debug: line() }
  /** Other DSH services `ctx.get` finds (`browserUse`, say). */
  const services: Record<string, unknown> = {}
  const ctx = {
    webServer: { register: vi.fn((route: CapturedRoute) => { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) } }) },
    logger,
    get: vi.fn((name: string) => services[name]),
  }
  const clock = manualClock(options.now ?? '2026-11-25T07:00')
  const driver = new FakeDriver()
  const complete = vi.fn<ModelClient['complete']>(async () => ({ text: '今天一条重要更新。', usage: usage({ inputTokens: 1000 }) }))
  const icons = { fetch: vi.fn(async (_productId: string, _candidates: string[]) => null as string | null) }
  const config = options.config?.(dataDir) ?? Config({ dataDir })

  /** A runtime on this host (not started). */
  const create = () => new Runtime(ctx as never, config, { driver, model: { complete }, clock: clock.clock, icons })

  /**
   * Sends `METHOD /outpost/api/<path>` with an optional JSON body (a string is sent as is). A change (anything but GET) is
   * sent with `content-type: application/json`, as the panel sends it, unless `headers` say otherwise.
   */
  async function call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Reply> {
    const route = routes[0]
    if (!route) throw new Error('no route registered')
    const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sentHeaders = headers ?? (method === 'GET' ? {} : { 'content-type': 'application/json' })
    const req = Object.assign(Readable.from(raw), { method, url: `/outpost/api/${path}`, headers: sentHeaders })
    const sent = { status: 0, headers: {} as Record<string, string>, body: Buffer.alloc(0) }
    const res = {
      writeHead: (status: number, headers: Record<string, string> = {}) => { sent.status = status; sent.headers = headers; return res },
      end: (chunk?: string | Uint8Array) => { sent.body = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk) },
    }
    await route.handler(req, res)
    return { ...sent, json: () => JSON.parse(sent.body.toString('utf8')) }
  }

  return {
    dir, dataDir, ctx, routes, logger, services, clock, driver, complete, icons, config, create, call,
    cleanup: () => { rmSync(dir, { recursive: true, force: true }) },
  }
}
export type ApiHost = ReturnType<typeof apiHost>
