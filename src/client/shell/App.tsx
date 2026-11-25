/**
 * The panel (design §5.1, mockup 1 option B): the middle column, and the right column filling the rest with the page of
 * the route. It reads `GET state` for the column (every 5 s, 2 s while something runs or the plugin does not answer) and
 * hands each answer to `onState` (the sidebar count follows it). Below ~720px of panel width the column hides behind a
 * menu button (the stylesheet's container query).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Id } from '../../core/types.ts'
import type { StateView } from '../../host/api.ts'
import { call, usePoll } from '../api.ts'
import type { T } from '../locales.ts'
import { MenuIcon, TelescopeIcon } from '../ui/icons.tsx'
import { Today } from '../pages/Today.tsx'
import { ShellContext, useShell, type SessionAccess, type Shell } from './context.ts'
import { BUSY_POLL_MS, IDLE_POLL_MS, MiddleColumn } from './MiddleColumn.tsx'
import { useRoute, type Route } from './route.ts'

/** Whether the column shows something as it moves: a baseline's progress or a track being picked; or the plugin is not answering. */
const isBusy = (state: StateView | undefined, error: Error | undefined) => error !== undefined
  || !!state?.tracks.some(view => view.track.status === 'picking' || view.products.some(item => item.progress !== null))

/** A page still to come (新建赛道, 产品档案, 运行记录 and 设置 arrive with their own tasks): its title. */
function Placeholder({ title }: { title: string }): ReactNode {
  return <div className="op-page"><h1 className="op-page-title">{title}</h1></div>
}

/** The right column before the first track: what Outpost does, and the way to start. */
function Welcome(): ReactNode {
  const { t, navigate } = useShell()
  return <div className="op-page op-welcome">
    <span className="op-welcome-mark"><TelescopeIcon size={28} /></span>
    <h1 className="op-welcome-title">{t('welcome.title')}</h1>
    <p className="op-welcome-body">{t('welcome.body')}</p>
    <button type="button" className="op-button" data-variant="primary" onClick={() => { navigate({ page: 'newTrack' }) }}>{t('welcome.action')}</button>
  </div>
}

/** The page of the route. */
function Page(): ReactNode {
  const { t, route, state } = useShell()
  switch (route.page) {
    case 'today': return state && state.tracks.length === 0 ? <Welcome /> : <Today />
    case 'newTrack': return <Placeholder title={t('page.newTrack')} />
    case 'product': {
      const known = state?.tracks.flatMap(view => view.products).find(item => item.product.id === route.productId)
      return <Placeholder title={known?.product.name ?? t('page.product')} />
    }
    case 'runs': return <Placeholder title={t('nav.runs')} />
    case 'settings': return <Placeholder title={t('nav.settings')} />
  }
}

/** Identifies the page of a route, tabs and cards aside (a day of the brief is a page): moving to another one starts the right column at its top. */
const pageOf = (route: Route) => route.page === 'product' ? `product:${route.productId}` : route.page === 'newTrack' ? `newTrack:${route.trackId ?? ''}`
  : route.page === 'today' ? `today:${route.date ?? ''}` : route.page

/** `sessions` is DSH's session catalog and workspace, for the pages that open a session (追问). */
export function App({ t, onState, sessions }: { t: T; onState?: (state: StateView) => void; sessions?: SessionAccess }): ReactNode {
  const [route, setRoute] = useRoute()
  const [navOpen, setNavOpen] = useState(false)
  const [picks, setPicksState] = useState<Readonly<Record<Id, number>>>({})
  const [busy, setBusy] = useState(false)
  const { data: state, error: stateError, reload } = usePoll(() => call('GET state'), [], busy ? BUSY_POLL_MS : IDLE_POLL_MS)
  // Turning busy reads again at once, so the quicker pace starts now rather than after the slower wait in progress.
  useEffect(() => {
    const next = isBusy(state, stateError)
    if (next === busy) return
    setBusy(next)
    if (next) void reload()
  }, [state, stateError, busy, reload])
  const reported = useRef(onState)
  reported.current = onState
  useEffect(() => { if (state) reported.current?.(state) }, [state])

  const navigate = useCallback((next: Route) => { setRoute(next); setNavOpen(false) }, [setRoute])
  const refresh = useCallback(() => { void reload() }, [reload])
  const setPicks = useCallback((trackId: Id, count: number | null) => {
    setPicksState(previous => {
      const { [trackId]: _dropped, ...rest } = previous
      return count === null ? rest : { ...rest, [trackId]: count }
    })
  }, [])
  const shell = useMemo<Shell>(() => ({ t, route, navigate, state, stateError, refresh, picks, setPicks, sessions }),
    [t, route, navigate, state, stateError, refresh, picks, setPicks, sessions])

  const content = useRef<HTMLDivElement>(null)
  const page = pageOf(route)
  useEffect(() => { if (content.current) content.current.scrollTop = 0 }, [page])

  return <ShellContext.Provider value={shell}>
    <div className="op-app" data-nav-open={navOpen ? '' : undefined}>
      <MiddleColumn onChoose={() => { setNavOpen(false) }} />
      <div className="op-scrim" aria-hidden="true" onClick={() => { setNavOpen(false) }} />
      <div className="op-content" ref={content}>
        <div className="op-narrow-bar">
          <button type="button" className="op-nav-toggle" aria-label={t('nav.toggle')} aria-expanded={navOpen}
            onClick={() => { setNavOpen(open => !open) }}><MenuIcon /></button>
          <span className="op-narrow-title">{t('panel')}</span>
        </div>
        <Page />
      </div>
    </div>
  </ShellContext.Provider>
}
