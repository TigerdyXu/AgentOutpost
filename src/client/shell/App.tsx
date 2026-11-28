/**
 * The panel (design §5.1, mockup 1 option B): the middle column, and the right column filling the rest with the page of
 * the route. It reads `GET state` for the column (every 5 s, 2 s while something runs or the plugin does not answer) and
 * hands each answer to `onState` (the sidebar count follows it). Below ~720px of panel width the column hides behind a
 * menu button (the stylesheet's container query).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Id } from '../../core/types.ts'
import type { StateView } from '../../host/api.ts'
import { call, usePoll } from '../api.ts'
import type { T } from '../locales.ts'
import { MenuIcon, TelescopeIcon } from '../ui/icons.tsx'
import { AddProduct } from '../pages/AddProduct.tsx'
import { EditTrack } from '../pages/EditTrack.tsx'
import { NewTrack } from '../pages/NewTrack.tsx'
import { Product } from '../pages/Product.tsx'
import { Runs } from '../pages/Runs.tsx'
import { Recap } from '../pages/Recap.tsx'
import { Search } from '../pages/Search.tsx'
import { Settings } from '../pages/Settings.tsx'
import { Today } from '../pages/Today.tsx'
import { Topic } from '../pages/Topic.tsx'
import { Track } from '../pages/Track.tsx'
import { ShellContext, useShell, type SessionAccess, type Shell } from './context.ts'
import { BUSY_POLL_MS, IDLE_POLL_MS, MiddleColumn } from './MiddleColumn.tsx'
import { useRoute, type Route } from './route.ts'

/**
 * Whether the column shows something as it moves: a recommendation running for a track (the host says so; a track merely in
 * 挑选中 moves only when its reader does, and may stay so for days) or a baseline's progress; or the plugin is not answering.
 */
const isBusy = (state: StateView | undefined, error: Error | undefined) => error !== undefined
  || !!state?.tracks.some(view => view.recommending || view.products.some(item => item.progress !== null))

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
  const { route, state } = useShell()
  switch (route.page) {
    case 'today': return state && state.tracks.length === 0 ? <Welcome /> : <Today />
    case 'newTrack': return <NewTrack />
    case 'addProduct': return <AddProduct />
    case 'editTrack': return <EditTrack />
    case 'track': return <Track />
    case 'topic': return <Topic />
    case 'product': return <Product />
    case 'search': return <Search />
    case 'recap': return <Recap />
    case 'runs': return <Runs />
    case 'settings': return <Settings />
  }
}

/** Identifies the page of a route, tabs and cards aside (a day of the brief is a page): moving to another one starts the right column at its top. */
const pageOf = (route: Route) => route.page === 'product' ? `product:${route.productId}` : route.page === 'newTrack' ? `newTrack:${route.trackId ?? ''}`
  : route.page === 'addProduct' ? `addProduct:${route.trackId}` : route.page === 'editTrack' ? `editTrack:${route.trackId}` : route.page === 'track' ? `track:${route.trackId}` : route.page === 'topic' ? `topic:${route.topicId}` : route.page === 'recap' ? `recap:${route.trackId}:${route.week ?? ''}` : route.page === 'today' ? `today:${route.date ?? ''}` : route.page

/**
 * `sessions` is DSH's session catalog and workspace, for the pages that open a session (追问, 运行记录); `configForm` is DSH's
 * configuration form of this plugin's entry, for 设置.
 */
export function App({ t, onState, sessions, configForm }: {
  t: T; onState?: (state: StateView) => void; sessions?: SessionAccess; configForm?: ConfigPageForm | undefined
}): ReactNode {
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

  const navigate = useCallback((next: Route, options?: { keepColumn?: boolean }) => { setRoute(next); if (!options?.keepColumn) setNavOpen(false) }, [setRoute])
  const refresh = useCallback(() => { void reload() }, [reload])
  const setPicks = useCallback((trackId: Id, count: number | null) => {
    setPicksState(previous => {
      const { [trackId]: _dropped, ...rest } = previous
      return count === null ? rest : { ...rest, [trackId]: count }
    })
  }, [])
  const shell = useMemo<Shell>(() => ({ t, route, navigate, state, stateError, refresh, picks, setPicks, sessions, configForm }),
    [t, route, navigate, state, stateError, refresh, picks, setPicks, sessions, configForm])

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
