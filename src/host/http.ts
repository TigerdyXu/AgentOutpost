/** The `/outpost` route on DSH's Web server: JSON requests under `/outpost/api/`, authenticated by the host. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'

const PREFIX = '/outpost'
const API = `${PREFIX}/api/`
/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 128 * 1024

/** One API request as the route handler hands it on. `route` is `<METHOD> <path>`, the path relative to `/outpost/api/`. */
export interface ApiRequestParts {
  method: string
  /** Path after `/outpost/api/`, with each segment percent-decoded. */
  path: string
  /** Values of `:name` segments; filled by the API's route table, empty here. */
  params: Record<string, string>
  query: Record<string, string>
  /** Reads and parses the JSON request body. */
  body: () => Promise<unknown>
}

/** An error whose status and message the client sees. */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Buffer)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new ApiError(413, `The request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new ApiError(400, 'The request body is not JSON') }
}
/** Response headers as superagent sends them (`src/app/http.ts:72-74`). */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid request: ${issues.map(issue => issue.path || '(body)').join(', ')}`, issues }]
  }
  if (error instanceof ApiError) return [error.status, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}
function decoded(path: string): string {
  try { return path.split('/').map(segment => decodeURIComponent(segment)).join('/') }
  catch { throw new ApiError(400, 'A path segment has a malformed escape') }
}

/**
 * Register the `/outpost` prefix route. Paths outside `/outpost/api/` answer 404; every API request goes to `handle`, whose
 * result is the JSON response. Authentication is the Web server's default, `required`.
 * @param ctx - the plugin's Context.
 * @param handle - answers one request, called with `<METHOD> <path>` and the request's parts.
 * @returns the disposer removing the route.
 */
export function registerRoutes(ctx: Context, handle: (route: string, req: ApiRequestParts) => Promise<unknown>): () => void {
  return ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(API)) { res.writeHead(404); res.end(); return }
    try {
      const method = req.method ?? 'GET'
      const path = decoded(url.pathname.slice(API.length))
      const parts: ApiRequestParts = { method, path, params: {}, query: Object.fromEntries(url.searchParams), body: () => readBody(req) }
      json(res, 200, await handle(`${method} ${path}`, parts))
    } catch (error) { json(res, ...failure(error)) }
  } })
}
