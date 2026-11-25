/** Same-origin client of `/outpost/api/` and the polling hook the panel reads it with (after superagent src/client/api.ts). */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Id } from '../core/types.ts'
import type { Api, ApiRequest, ApiResponse } from '../host/api.ts'
import type { T } from './locales.ts'

/**
 * A failed request. `message` is the server's sentence when it sent one (`{ error }`), else empty. `starting` says the
 * plugin did not answer at all: the host was unreachable, or the DSH web server answered an empty 404 because the
 * plugin's routes are not mounted yet (starting or restarting), so a 404 then does not mean the record is missing.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly starting = false) { super(message) }
}

/** What the panel says about a failure: the server's sentence, 「前哨正在启动…」 while it does not answer, else the status. */
export function describeError(t: T, error: Error): string {
  if (error instanceof ApiError) return error.starting ? t('error.starting') : error.message || t('error.request', { status: error.status })
  return error.message
}

/** Methods that change nothing; every other request is sent as JSON, body or not (the server answers 415 otherwise). */
const READS = new Set(['GET', 'HEAD'])

async function request<V>(method: string, path: string, body: unknown): Promise<V> {
  const headers: Record<string, string> = READS.has(method) ? {} : { 'content-type': 'application/json' }
  let response: Response
  try {
    response = await fetch(`/outpost/api/${path}`, { method, headers, ...body === undefined ? {} : { body: JSON.stringify(body) } })
  } catch {
    throw new ApiError('', 0, true)
  }
  const text = await response.text().catch(() => '')
  let value: unknown
  try { value = text ? JSON.parse(text) as unknown : undefined } catch { value = undefined }
  if (!response.ok) {
    const error = (value as { error?: unknown } | undefined)?.error
    throw new ApiError(typeof error === 'string' ? error : '', response.status, !text && response.status === 404)
  }
  return value as V
}

/** What a caller passes for a route: nothing when the route takes nothing, else its params, `query` and `body`. */
export type CallArgs<K extends keyof Api> = {} extends ApiRequest<K> ? [request?: ApiRequest<K>] : [request: ApiRequest<K>]

/**
 * Calls one route of the API, e.g. `call('POST findings/:id/read', { id })` or `call('GET brief', { query: { date } })`:
 * `:name` segments come from the request's fields of that name, percent-encoded.
 * @throws ApiError when the request fails.
 */
export function call<K extends keyof Api>(route: K, ...[req]: CallArgs<K>): Promise<ApiResponse<K>> {
  const [method, pattern] = route.split(' ') as [string, string]
  const values = (req ?? {}) as Record<string, unknown> & { query?: Record<string, unknown>; body?: unknown }
  const path = pattern.replace(/:(\w+)/g, (_match, name: string) => encodeURIComponent(String(values[name])))
  const query = Object.entries(values.query ?? {}).filter(([, value]) => value !== undefined && value !== '')
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`).join('&')
  return request(method, query ? `${path}?${query}` : path, values.body)
}

/** How much slower polling runs while the document is hidden. */
const HIDDEN_FACTOR = 6
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * Polls `load` while mounted, every `intervalMs` (the caller passes 2000 while a run is in progress; a new interval
 * applies from the next wait), more slowly while the document is hidden and at once when it shows again. `intervalMs` may
 * also be a function of the answer just read (undefined after a failure), so that the wait after it follows what it said.
 * Keeps the last value across failures and `deps` changes, skips updates when the answer did not change, and drops answers
 * of an earlier `deps`. `reload` polls now, after the poll in flight.
 */
export function usePoll<V>(load: () => Promise<V>, deps: readonly unknown[], intervalMs: number | ((latest: V | undefined) => number) = 5000) {
  const [state, setState] = useState<{ data?: V; error?: Error }>({})
  const loader = useRef(load)
  loader.current = load
  const every = useRef(intervalMs)
  every.current = intervalMs
  const refresh = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let latest: V | undefined
    // One request at a time, so a reload after a change runs after the poll in flight.
    let queue = Promise.resolve()
    const once = async () => {
      clearTimeout(timer)
      try {
        const value = await loader.current()
        latest = value
        if (active) setState(previous => same(previous.data, value) ? previous.error ? { data: previous.data as V } : previous : { data: value })
      } catch (failure) {
        latest = undefined
        if (active) setState(previous => ({ ...previous, error: failure instanceof Error ? failure : new Error(String(failure)) }))
      } finally {
        const wait = typeof every.current === 'function' ? every.current(latest) : every.current
        if (active) timer = setTimeout(run, document.hidden ? wait * HIDDEN_FACTOR : wait)
      }
    }
    const run = () => (queue = queue.then(once))
    const shown = () => { if (!document.hidden) void run() }
    refresh.current = run
    void run()
    document.addEventListener('visibilitychange', shown)
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  const reload = useCallback(() => refresh.current(), [])
  return { data: state.data, error: state.error, reload }
}

/** How often a track's candidates are read while its recommendation runs, and while none does (a new one may have started). */
export const CANDIDATES_FAST_MS = 2000
export const CANDIDATES_SLOW_MS = 30_000

/**
 * The candidates of a track's latest recommendation (`GET tracks/:id/candidates`), polled every 2 s while it runs and every
 * 30 s once it does not; before the first answer, and while the plugin does not answer, every 2 s. A read made on purpose
 * (`reload`, after a refinement was sent) sees the new round running and the quick pace starts from it.
 */
export function useCandidates(trackId: Id) {
  return usePoll(() => call('GET tracks/:id/candidates', { id: trackId }), [trackId], view => view?.running === false ? CANDIDATES_SLOW_MS : CANDIDATES_FAST_MS)
}
