import { Readable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError, INTERNAL_ERROR, matchRoute, RawReply, registerRoutes, type ApiRequestParts } from '../../src/host/http.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Route = { kind: string; path: string; handler: Handler; auth?: unknown }

/** A Context whose fake `webServer.register` captures the route, and whose logger records what it is told. */
function host() {
  const routes: Route[] = []
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = {
    webServer: { register: vi.fn((route: Route) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } }) },
    logger,
  }
  return { ctx, routes, logger }
}
/** Call a captured route handler as the Web server would, with an incoming request carrying `body`. */
async function request(route: Route, method: string, url: string, body?: string | Buffer) {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { method, url, headers: {} })
  const sent = { status: 0, headers: {} as Record<string, string>, body: '' as string | Buffer, heads: 0 }
  const res = {
    writeHead: (status: number, headers: Record<string, string> = {}) => { sent.status = status; sent.headers = headers; sent.heads++; return res },
    end: (chunk?: string | Buffer) => { sent.body = chunk === undefined ? '' : chunk },
  }
  await route.handler(req, res)
  return { ...sent, json: () => JSON.parse(String(sent.body)) as unknown }
}
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

it('registers one /outpost prefix route with the host\'s default auth, answers JSON, and goes away on dispose', async () => {
  const { ctx, routes } = host()
  const dispose = registerRoutes(ctx as never, async route => {
    if (route === 'GET health') return { ok: true }
    throw new ApiError(404, 'Unknown operation')
  })
  expect(routes).toHaveLength(1)
  const route = routes[0]!
  // `auth` left out so the host's default, `required`, authenticates every request.
  expect(route).toMatchObject({ kind: 'prefix', path: '/outpost' })
  expect(route.auth).toBeUndefined()
  const answer = await request(route, 'GET', '/outpost/api/health')
  expect(answer.status).toBe(200)
  expect(answer.headers).toEqual(JSON_HEADERS)
  expect(answer.json()).toEqual({ ok: true })
  expect((await request(route, 'GET', '/outpost/api/unknown')).status).toBe(404)
  dispose()
  expect(routes).toHaveLength(0)
})

it('returns 404 outside /outpost/api/, 400 for a non-JSON body, and undefined for an empty one', async () => {
  const { ctx, routes } = host()
  const handle = vi.fn(async (route: string, req: ApiRequestParts) => {
    if (route === 'POST echo') return { echoed: (await req.body()) ?? 'nothing' }
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
  // A POST without a body (the client sends none when there is nothing to say) reads as undefined, not as bad JSON.
  expect((await request(route, 'POST', '/outpost/api/echo')).json()).toEqual({ echoed: 'nothing' })
})

it('passes the method, the path as sent and the query to the handler', async () => {
  const { ctx, routes } = host()
  const seen: { route: string; req: ApiRequestParts }[] = []
  registerRoutes(ctx as never, async (route, req) => { seen.push({ route, req }); return null })
  const answer = await request(routes[0]!, 'GET', '/outpost/api/products/a%2Fb/findings?date=2026-11-25&x=1')
  expect(answer.status).toBe(200)
  expect(answer.json()).toBeNull()
  // Not decoded here: a `%2F` inside a segment must not turn into a separator before the route table splits the path.
  expect(seen[0]!.route).toBe('GET products/a%2Fb/findings')
  expect(seen[0]!.req).toMatchObject({ method: 'GET', path: 'products/a%2Fb/findings', params: {}, query: { date: '2026-11-25', x: '1' } })
})

it('decodes only the matched params: an escaped slash stays inside its param', () => {
  expect(matchRoute('products/:id/findings', 'products/a%2Fb/findings')).toEqual({ id: 'a/b' })
  expect(matchRoute('products/:id', 'products/%E4%BB%8A%E5%A4%A9')).toEqual({ id: '今天' })
  expect(matchRoute('products/:id', 'products/a/b')).toBeNull() // two segments: not this route
  expect(matchRoute('products/:id', 'products/')).toBeNull() // an empty param matches nothing
  expect(matchRoute('products/:id/findings', 'products/p1/sources')).toBeNull()
  expect(matchRoute('state', 'state')).toEqual({})
  expect(matchRoute('state', 'stat%65')).toBeNull() // fixed segments are compared as sent
  // A param that is not valid percent-encoding is a bad request, but only once the route's fixed segments matched.
  expect(() => matchRoute('products/:id', 'products/%E4')).toThrow(expect.objectContaining({ status: 400 }))
  expect(matchRoute('products/:id/findings', 'products/%E4/sources')).toBeNull()
})

it('maps zod errors to 400, ApiError to its own status and headers, and anything else to a logged 500 with a plain message', async () => {
  const { ctx, routes, logger } = host()
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
  expect(logger.error).not.toHaveBeenCalled() // expected refusals are not logged as failures

  const broken = await request(routes[0]!, 'GET', '/outpost/api/other')
  expect(broken.status).toBe(500)
  expect(broken.headers).toEqual(JSON_HEADERS)
  expect(broken.json()).toEqual({ error: INTERNAL_ERROR }) // the client learns nothing of the internals
  expect(logger.error).toHaveBeenCalledOnce()
  const logged = logger.error.mock.calls[0]!.map(String).join(' ')
  expect(logged).toContain('GET other')
  expect(logged).toContain('disk full')
  expect(logged).toMatch(/at .*http\.spec\.ts/) // the stack, to find where it broke
})

it('answers null for nothing, and a clean 500 (one head, logged) for a result that is not JSON', async () => {
  const { ctx, routes, logger } = host()
  registerRoutes(ctx as never, async route => route === 'GET nothing' ? undefined : { count: 1n })
  const nothing = await request(routes[0]!, 'GET', '/outpost/api/nothing')
  expect(nothing.status).toBe(200)
  expect(nothing.body).toBe('null') // never an empty 200 the client cannot parse
  const bigint = await request(routes[0]!, 'GET', '/outpost/api/bigint')
  expect(bigint.status).toBe(500)
  expect(bigint.heads).toBe(1) // the headers were not sent before the body failed to serialize
  expect(bigint.json()).toEqual({ error: INTERNAL_ERROR })
  expect(logger.error).toHaveBeenCalledOnce()
})

it('refuses a request body over 128 KiB and closes the connection', async () => {
  const { ctx, routes } = host()
  registerRoutes(ctx as never, async (_route, req) => req.body())
  const fits = JSON.stringify('x'.repeat(128 * 1024 - 2))
  const ok = await request(routes[0]!, 'POST', '/outpost/api/save', fits)
  expect(ok.status).toBe(200)
  expect(ok.headers.connection).toBeUndefined()
  const over = await request(routes[0]!, 'POST', '/outpost/api/save', JSON.stringify('x'.repeat(128 * 1024)))
  expect(over.status).toBe(413)
  expect(over.json()).toEqual({ error: 'The request body exceeds 131072 bytes' })
  // The rest of the body is left unread, so the socket cannot serve another request: tell a keep-alive client so.
  expect(over.headers).toEqual({ ...JSON_HEADERS, connection: 'close' })
})

it('sends a raw reply with its own headers', async () => {
  const { ctx, routes } = host()
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  registerRoutes(ctx as never, async () => new RawReply(bytes, { 'content-type': 'image/png', 'cache-control': 'max-age=86400' }))
  const answer = await request(routes[0]!, 'GET', '/outpost/api/icons/p1')
  expect(answer.status).toBe(200)
  expect(answer.headers).toEqual({ 'content-type': 'image/png', 'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff' })
  expect(Buffer.compare(answer.body as Buffer, bytes)).toBe(0)
})
