/**
 * Panel test helpers: a fake client context for `apply`, a stubbed `/outpost/api/` (`stubApi`, through `fetch`), sample
 * state, mounting inside the shell's context, and clicks and text as a user sees them (as superagent tests/fixtures/panel.tsx).
 */
import { act, type ComponentType, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, vi } from 'vitest'
import type { Brief, CardVersion, Facts, Finding, Product, Run, Source, Track } from '../../src/core/types.ts'
import type { Api, BriefView, ProductView, StateView, TrackProductView, TrackView } from '../../src/host/api.ts'
import { zh, type T } from '../../src/client/locales.ts'
import { ShellContext, type Shell } from '../../src/client/shell/context.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Chinese dictionary lookup with `{name}` substitution, as the locale service's bound `t` does. */
export const t = ((key: keyof typeof zh, params: Record<string, unknown> = {}) =>
  (zh[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)) as T

// ---- a fake client context ----

type Options = { name: string; id?: string; key?: string; order?: number; locale?: string; label?: () => string; inject?: () => unknown }
export type Entry = { options: Options; component: ComponentType<Record<string, unknown>> }

/**
 * A client context that records slot registrations, dictionaries and effect disposers (as in superagent tests/client.spec.tsx).
 * `get` answers `ctx.get(name)`, the optional services (`configForms`, say); none by default.
 */
export function fakeCtx(get: (name: string) => unknown = () => undefined) {
  const entries: Entry[] = []
  const dictionaries: Record<string, unknown> = {}
  const disposers: (() => void)[] = []
  const ctx = {
    slots: {
      inject: (_name: string, register: () => () => void) => { disposers.push(register()) },
      register: (options: Options, component: Entry['component']) => { entries.push({ options, component }); return () => {} },
    },
    locale: { register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} }, bind: () => t },
    effect: (effect: () => unknown) => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose as () => void) },
    sessions: {},
    uiWorkspace: { openSession: () => {} },
    get,
  }
  const entry = (name: string) => entries.find(item => item.options.name === name)!
  return { ctx, entries, dictionaries, entry, dispose: () => { for (const dispose of disposers.splice(0)) dispose() } }
}

// ---- a stubbed API ----

export interface StubRequest {
  method: string
  /** Path after `/outpost/api/`, query excluded. */
  path: string
  params: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
  /** The parsed JSON body, or undefined when none was sent. */
  body: unknown
}
/** An answer other than 200: the status, and the JSON body (none when `body` is undefined, as a server not yet up). */
export class Failure { constructor(readonly status: number, readonly body?: unknown) {} }
export const fail = (status: number, error?: string) => new Failure(status, error === undefined ? undefined : { error })
type Answer = unknown | ((req: StubRequest) => unknown)
export type Routes = { [K in keyof Api]?: Api[K]['response'] | Failure | ((req: StubRequest) => unknown) } & Record<string, Answer>

/** Matches `products/:id/findings`-style patterns against a path; the params, or null. */
function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/'), got = path.split('/')
  if (want.length !== got.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith(':')) params[want[i]!.slice(1)] = decodeURIComponent(got[i]!)
    else if (want[i] !== got[i]) return null
  }
  return params
}

/**
 * Answers `fetch` under `/outpost/api/` from `routes` (`'GET state': value`, a `Failure`, or a function of the request);
 * a route not listed answers 404 with an error naming it. Every request is kept in `requests`, in order. Calling it
 * again replaces the answers.
 */
export function stubApi(routes: Routes) {
  const requests: StubRequest[] = []
  let pending = 0
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    pending++
    try {
      await Promise.resolve()
      const url = new URL(String(input), 'http://localhost')
      const method = init.method ?? 'GET'
      const path = url.pathname.replace(/^\/outpost\/api\//, '')
      const headers = Object.fromEntries(new Headers(init.headers).entries())
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined
      for (const [route, answer] of Object.entries(routes)) {
        const [verb, pattern] = route.split(' ') as [string, string]
        const params = verb === method ? match(pattern, path) : null
        if (!params) continue
        const req: StubRequest = { method, path, params, query: Object.fromEntries(url.searchParams), headers, body }
        requests.push(req)
        const value = typeof answer === 'function' ? await (answer as (req: StubRequest) => unknown)(req) : answer
        if (value instanceof Failure) return new Response(value.body === undefined ? null : JSON.stringify(value.body), { status: value.status })
        return Response.json(value)
      }
      requests.push({ method, path, params: {}, query: Object.fromEntries(url.searchParams), headers, body })
      return Response.json({ error: `no stub for ${method} ${path}` }, { status: 404 })
    } finally {
      pending--
    }
  })
  vi.stubGlobal('fetch', fetch)
  const api = { fetch, requests, get pending() { return pending } }
  current = api
  return api
}
/** The latest `stubApi`, whose requests `settle` waits for. */
let current: { readonly pending: number } | undefined

// ---- sample data ----

export const product = (id: string, name: string, extra: Partial<Product> = {}): Product => ({
  id, name, company: '某公司', region: 'domestic', form: 'App', iconPath: null, officialDomains: [], status: 'tracking', dailyBudgetYuan: null,
  createdAt: '2026-11-18T08:00:00.000Z', ...extra,
})
export const tracked = (p: Product, extra: Partial<TrackProductView> = {}): TrackProductView => ({ product: p, hasNew: false, progress: null, ...extra })
export const track = (id: string, name: string, products: TrackProductView[], extra: Partial<Track> = {}, candidatesToReview = 0): TrackView => ({
  track: { id, name, brief: '', dimensions: [], status: 'active', createdAt: '2026-11-18T08:00:00.000Z', ...extra },
  products, candidatesToReview, recommending: false,
})
export const state = (extra: Partial<StateView> = {}): StateView => ({
  tracks: [], todayDate: '2026-11-25', todayUnread: 0, todayCostYuan: 0, runTime: '08:00', browserAvailable: true, browserMissing: false, researchBroken: false, dataDir: '/Users/tiger/Projects/AgentOutpost-data', ...extra,
})

/** A verified, unread major finding of `productId` that cites nothing, from today's run. */
export const finding = (id: string, productId: string, extra: Partial<Finding> = {}): Finding => ({
  id, productId, runId: 'r1', headline: `标题 ${id}`, why: `原因 ${id}`, importance: 'major', claimKind: 'self', sourceIds: [], status: 'verified',
  statusNote: null, unconfirmedUntil: null, dimensions: [], inference: false, read: false, late: false, dedupeKey: id,
  createdAt: '2026-11-25T08:05:00.000Z', verifiedOn: '2026-11-25', ...extra,
})
export const source = (id: string, extra: Partial<Source> = {}): Source => ({
  id, url: `https://example.com/${id}`, title: `来源 ${id}`, publisher: `发布方 ${id}`, publishedAt: '2026-11-24', kind: 'media', isOfficial: false,
  quote: `${id} 的原话`, syndicationGroup: null, openedVia: 'http', quoteFound: true, supportsClaim: true, ...extra,
})
export const brief = (extra: Partial<Brief> = {}): Brief => ({
  date: '2026-11-25', gist: '', findingIds: [], minorIds: [], quietProductIds: [], skipped: [], costYuan: 0,
  // 08:12 on the machine's own clock, whatever its time zone: the page shows the time of day as the reader's clock has it.
  createdAt: new Date(2026, 10, 25, 8, 12).toISOString(), updatedAt: new Date(2026, 10, 25, 8, 12).toISOString(), ...extra,
})
/** `GET brief`'s answer: the brief, its findings, the products it names and the sources of the findings. */
export const briefView = (extra: Partial<BriefView> = {}): BriefView => ({ brief: brief(), findings: [], products: [], sources: [], changed: {}, prevDate: null, ...extra })

/** A card of `dimension`, written at the baseline (version 1, nothing highlighted); `body` is the text, `[n]` citing `sourceIds[n - 1]`. */
export const card = (productId: string, dimension: string, extra: Partial<CardVersion> = {}): CardVersion => ({
  productId, dimension, version: 1, summary: `${dimension} 的一句话`, bullets: [`${dimension} 结论一`, `${dimension} 结论二`], body: `${dimension} 的全文。`,
  sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '建档', findingIds: [], createdAt: '2026-11-18T08:00:00.000Z', ...extra,
})
export const facts = (productId: string, extra: Partial<Facts> = {}): Facts => ({
  productId, version: 1, form: 'App 内代理', platforms: '安卓 · iOS 内测', price: '免费', firstReleased: '2026-09', rivals: ['Meta Muse', '蚂蚁灵光'],
  createdAt: '2026-11-18T08:00:00.000Z', ...extra,
})
/** `GET products/:id`'s answer: no card, no fact, no source and no progress until given. */
export const productView = (p: Product, extra: Partial<ProductView> = {}): ProductView => ({
  product: p, facts: null, cards: [], history: {}, sources: [], dimensions: [], progress: null, ...extra,
})
export const run = (id: string, productId: string | null, status: Run['status'], extra: Partial<Run & { productName: string | null }> = {}): Run & { productName: string | null } => ({
  id, kind: 'daily', date: '2026-11-25', trackId: null, productId, sessionId: null, status, startedAt: '2026-11-25T08:00:00.000Z', endedAt: null,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, costYuan: 0, error: null, progress: null, subject: null, productName: null, ...extra,
})

// ---- rendering ----

let root: Root | undefined
let container: HTMLElement | undefined

/** A shell context for components mounted on their own; `navigate` and the rest are spies. */
export function fakeShell(extra: Partial<Shell> = {}): Shell {
  return { t, route: { page: 'today' }, navigate: vi.fn(), state: undefined, stateError: undefined, refresh: vi.fn(), picks: {}, setPicks: vi.fn(), ...extra }
}

/** Lets timers due now (fake ones too), stubbed responses and React updates run. */
const tick = () => act(async () => { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0); else await new Promise(resolve => setTimeout(resolve, 0)) })
/** Runs what is due until no stubbed request is in flight. */
export async function settle() {
  await vi.waitFor(async () => {
    await tick()
    expect(current?.pending ?? 0).toBe(0)
  })
  await tick()
}

/** Renders `node` inside a shell context (`fakeShell(shell)`); the shell's own `App` brings its own. */
export async function mount(node: ReactNode, shell: Partial<Shell> = {}) {
  unmount()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const value = fakeShell(shell)
  await act(async () => { root!.render(<ShellContext.Provider value={value}>{node}</ShellContext.Provider>) })
  await settle()
  return value
}
export function unmount() {
  if (root) act(() => { root!.unmount() })
  root = undefined
  container?.remove()
  container = undefined
}

/** Types `value` into a text field as a user would (React sees an input event, not a property write). */
export async function type(target: string | Element, value: string) {
  const field = (typeof target === 'string' ? document.querySelector(target) : target) as HTMLInputElement | HTMLTextAreaElement
  const setter = Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
}
/** Submits the form as a click on its submit button, or Enter in a field, would. */
export async function submit(form: string | Element) {
  const element = (typeof form === 'string' ? document.querySelector(form) : form) as HTMLFormElement
  await act(async () => { element.requestSubmit() })
  await settle()
}

export const all = <E extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<E & Element>(selector)] as E[]
const CONTROLS = 'button, a, [role="button"]'
/** The control whose text, or accessible name, is `name`. */
export function find(name: string, selector = CONTROLS): HTMLElement {
  const named = (element: HTMLElement) => element.getAttribute('aria-label') === name || element.textContent?.trim() === name
  const match = all(selector).find(named) ?? all(selector).find(element => element.textContent?.trim().startsWith(name))
  if (!match) throw new Error(`No ${selector} named ${name}`)
  return match
}
export async function click(target: string | Element) {
  const element = typeof target === 'string' ? find(target) : target as HTMLElement
  await act(async () => { element.click() })
  await settle()
}
/** The page's text, stylesheets left out. */
export const text = () => [...document.body.querySelectorAll('style')].reduce((all, style) => all.replace(style.textContent ?? '', ''),
  document.body.textContent ?? '')
