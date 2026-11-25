import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { apply } from '../../src/index.ts'
import { ApiError, registerRoutes, type ApiRequestParts } from '../../src/host/http.ts'
import { Config } from '../../src/config.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Route = { kind: string; path: string; handler: Handler; auth?: unknown }

/** A Context whose fake `webServer.register` captures the route, and whose `effect` records disposers. */
function host() {
  const routes: Route[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    webServer: { register: vi.fn((route: Route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } }) },
    effect: (effect: () => unknown) => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose as () => void) },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  return { ctx, routes, dispose: () => { for (const dispose of disposers.splice(0)) dispose() } }
}
/** Call a captured route handler as the Web server would, with an incoming request carrying `body`. */
async function request(route: Route, method: string, url: string, body?: string | Buffer) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { method, url, headers: {} })
  const sent = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    writeHead: (status: number, headers: Record<string, string> = {}) => { sent.status = status; sent.headers = headers; return res },
    end: (chunk?: string | Buffer) => { sent.body = chunk === undefined ? '' : String(chunk) },
  }
  await route.handler(req, res)
  return { ...sent, json: () => JSON.parse(sent.body) as unknown }
}

it('answers GET /outpost/api/health with {ok:true}', async () => {
  const { ctx, routes, dispose } = host()
  await apply(ctx as never, Config({ dataDir: '/tmp/outpost-test' }))
  expect(routes).toHaveLength(1)
  const route = routes[0]!
  // One prefix route; `auth` left out so the host's default, `required`, authenticates every request.
  expect(route).toMatchObject({ kind: 'prefix', path: '/outpost' })
  expect(route.auth).toBeUndefined()
  const answer = await request(route, 'GET', '/outpost/api/health')
  expect(answer.status).toBe(200)
  expect(answer.headers).toEqual({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  expect(answer.json()).toEqual({ ok: true })
  expect((await request(route, 'GET', '/outpost/api/unknown')).status).toBe(404)
  dispose()
  expect(routes).toHaveLength(0)
})

it('returns 404 outside /outpost/api/ and 400 for a non-JSON body', async () => {
  const { ctx, routes } = host()
  const handle = vi.fn(async (route: string, req: ApiRequestParts) => {
    if (route === 'POST echo') return { echoed: await req.body() }
    throw new ApiError(404, 'Unknown operation')
  })
  registerRoutes(ctx as never, handle)
  const route = routes[0]!
  for (const url of ['/outpost', '/outpost/', '/outpost/index.html', '/outpost/apix/health']) {
    const answer = await request(route, 'GET', url)
    expect(answer.status, url).toBe(404)
  }
  expect(handle).not.toHaveBeenCalled()
  const bad = await request(route, 'POST', '/outpost/api/echo', 'not json')
  expect(bad.status).toBe(400)
  expect(bad.headers['content-type']).toBe('application/json; charset=utf-8')
  expect(bad.json()).toEqual({ error: 'The request body is not JSON' })
  const good = await request(route, 'POST', '/outpost/api/echo', '{"a":1}')
  expect(good.status).toBe(200)
  expect(good.json()).toEqual({ echoed: { a: 1 } })
})

it('passes the method, path, decoded segments and query to the handler', async () => {
  const { ctx, routes } = host()
  const seen: { route: string; req: ApiRequestParts }[] = []
  registerRoutes(ctx as never, async (route, req) => { seen.push({ route, req }); return null })
  const answer = await request(routes[0]!, 'GET', '/outpost/api/brief/%E4%BB%8A%E5%A4%A9?date=2026-11-25&x=1')
  expect(answer.status).toBe(200)
  expect(answer.json()).toBeNull()
  expect(seen[0]!.route).toBe('GET brief/今天')
  expect(seen[0]!.req).toMatchObject({ method: 'GET', path: 'brief/今天', params: {}, query: { date: '2026-11-25', x: '1' } })
  expect((await request(routes[0]!, 'GET', '/outpost/api/brief/%E4')).status).toBe(400)
})

it('maps zod errors to 400, ApiError to its own status and anything else to 500', async () => {
  const { ctx, routes } = host()
  registerRoutes(ctx as never, async route => {
    if (route === 'POST invalid') return z.object({ name: z.string().max(20) }).parse({ name: 'x'.repeat(21) })
    if (route === 'GET gone') throw new ApiError(409, 'Already started')
    throw new Error('disk full')
  })
  const invalid = await request(routes[0]!, 'POST', '/outpost/api/invalid')
  expect(invalid.status).toBe(400)
  expect(invalid.json()).toMatchObject({ issues: [{ path: 'name' }] })
  const conflict = await request(routes[0]!, 'GET', '/outpost/api/gone')
  expect(conflict.status).toBe(409)
  expect(conflict.json()).toEqual({ error: 'Already started' })
  const broken = await request(routes[0]!, 'GET', '/outpost/api/other')
  expect(broken.status).toBe(500)
  expect(broken.json()).toEqual({ error: 'disk full' })
})

it('refuses a request body over 128 KiB', async () => {
  const { ctx, routes } = host()
  registerRoutes(ctx as never, async (_route, req) => req.body())
  const fits = JSON.stringify('x'.repeat(128 * 1024 - 2))
  expect((await request(routes[0]!, 'POST', '/outpost/api/save', fits)).status).toBe(200)
  const over = await request(routes[0]!, 'POST', '/outpost/api/save', JSON.stringify('x'.repeat(128 * 1024)))
  expect(over.status).toBe(413)
  expect(over.json()).toEqual({ error: 'The request body exceeds 131072 bytes' })
})
