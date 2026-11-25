/** The `/outpost` route on DSH's Web server: JSON requests under `/outpost/api/`, authenticated by the host. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'

const PREFIX = '/outpost'
const API = `${PREFIX}/api/`
/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 128 * 1024
/** What the client is told of a failure nobody expected; the details go to the DSH log. */
export const INTERNAL_ERROR = '前哨内部出错，详情见 DSH 日志'

/** One API request as the route handler hands it on. `route` is `<METHOD> <path>`, the path relative to `/outpost/api/`. */
export interface ApiRequestParts {
  method: string
  /** Path after `/outpost/api/`, as sent: percent-escapes are kept, so that an escaped `/` stays inside its segment. */
  path: string
  /** Values of the route's `:name` segments, each percent-decoded (`matchRoute`); filled by the API's route table, empty here. */
  params: Record<string, string>
  query: Record<string, string>
  /** Reads and parses the JSON request body; undefined when there is none. */
  body: () => Promise<unknown>
}

/** An error whose status and message the client sees, with any headers the reply needs. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) { super(message) }
}

/** A reply that is not JSON (an image, say): its bytes are sent as they are, with these headers. */
export class RawReply {
  constructor(readonly body: Uint8Array, readonly headers: Record<string, string>, readonly status = 200) {}
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Buffer)
    size += bytes.length
    // What is left of the body stays unread, so the connection cannot carry another request: say so, or a keep-alive
    // client would send its next request into a socket the server is about to drop.
    if (size > MAX_BODY_BYTES) throw new ApiError(413, `The request body exceeds ${MAX_BODY_BYTES} bytes`, { connection: 'close' })
    chunks.push(bytes)
  }
  if (!size) return undefined
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new ApiError(400, 'The request body is not JSON') }
}

/** Methods that only read: everything else changes something and must come as JSON. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS'])
/** What a change is refused with when it is not sent as JSON. */
export const NOT_JSON = '请求必须是 JSON'

/**
 * Whether the request says its body is JSON (`application/json`, any parameters, any case). A cross-site form or a
 * plain cross-origin fetch can only send form or text types without the browser asking the server first, so requiring
 * this keeps another web page from changing anything here, on top of the host's authentication.
 */
function sentAsJson(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.split(';')[0]!.trim().toLowerCase() === 'application/json'
}

/** Response headers as superagent sends them (`src/app/http.ts:72-74`). */
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }

/** Sends `value` as JSON. The text is made before anything is written, so a value that cannot be serialized still gets a clean 500. */
function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(value ?? null) ?? 'null' // never an empty body: a function or symbol stringifies to undefined
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(text)
}

/** The reply to a failure: a zod error is the client's (400), an `ApiError` says its own; anything else is logged and hidden. */
function failure(error: unknown, log: (error: unknown) => void): [number, Record<string, unknown>, Record<string, string>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid request: ${issues.map(issue => issue.path || '(body)').join(', ')}`, issues }, {}]
  }
  if (error instanceof ApiError) return [error.status, { error: error.message }, error.headers]
  log(error)
  return [500, { error: INTERNAL_ERROR }, {}]
}

/**
 * Matches `path` (as sent, see `ApiRequestParts.path`) against a route pattern such as `products/:id/findings`, segment by
 * segment: fixed segments must be equal as sent, and each `:name` takes one non-empty segment, percent-decoded only after
 * the whole pattern matched. An escaped `/` (`%2F`) therefore stays inside its param instead of splitting it.
 * @returns the decoded params, or null when the path is not this route.
 * @throws ApiError 400 when a param of a matching path is not valid percent-encoding.
 */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return null
  for (let i = 0; i < want.length; i++) {
    const fixed = !want[i]!.startsWith(':')
    if (fixed ? want[i] !== got[i] : !got[i]) return null
  }
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    if (!want[i]!.startsWith(':')) continue
    try { params[want[i]!.slice(1)] = decodeURIComponent(got[i]!) }
    catch { throw new ApiError(400, 'A path segment has a malformed escape') }
  }
  return params
}

/**
 * Register the `/outpost` prefix route. Paths outside `/outpost/api/` answer 404; a request that changes something (any
 * method but GET, HEAD and OPTIONS) without `content-type: application/json` answers 415 `NOT_JSON`, unread. Every other
 * API request goes to `handle`, whose result is the response: JSON, or a `RawReply` sent as it is. A failure nobody
 * expected is logged with its stack through `ctx.logger` and answered with `INTERNAL_ERROR`. Authentication is the Web
 * server's default, `required`.
 * @param ctx - the plugin's Context.
 * @param handle - answers one request, called with `<METHOD> <path>` and the request's parts.
 * @returns the disposer removing the route.
 */
export function registerRoutes(ctx: Context, handle: (route: string, req: ApiRequestParts) => Promise<unknown>): () => void {
  return ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(API)) { res.writeHead(404); res.end(); return }
    const method = req.method ?? 'GET'
    const path = url.pathname.slice(API.length)
    const log = (error: unknown) => {
      ctx.logger.error('dsh-outpost: %s %s failed: %s', method, path, error instanceof Error ? error.stack ?? error.message : String(error))
    }
    try {
      if (!READS.has(method) && !sentAsJson(req)) throw new ApiError(415, NOT_JSON) // before anything is read or done
      const parts: ApiRequestParts = { method, path, params: {}, query: Object.fromEntries(url.searchParams), body: () => readBody(req) }
      const value = await handle(`${method} ${path}`, parts)
      if (value instanceof RawReply) {
        res.writeHead(value.status, { ...value.headers, 'x-content-type-options': 'nosniff' })
        res.end(value.body)
      } else {
        json(res, 200, value)
      }
    } catch (error) {
      json(res, ...failure(error, log))
    }
  } })
}
