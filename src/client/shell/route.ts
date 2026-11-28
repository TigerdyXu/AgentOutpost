/** The panel's pages (its in-panel routes), and the route state that remembers the last one in `localStorage`. */
import { useCallback, useState } from 'react'
import type { DimensionKey, Id } from '../../core/types.ts'

export type ProductTab = 'dossier' | 'feed' | 'sources'
export type Route =
  | { page: 'today'; date?: string }
  | { page: 'newTrack'; trackId?: Id }
  | { page: 'addProduct'; trackId: Id }
  | { page: 'editTrack'; trackId: Id }
  | { page: 'track'; trackId: Id }
  | { page: 'product'; productId: Id; tab: ProductTab; expand?: DimensionKey }
  | { page: 'runs' }
  | { page: 'settings' }

export const HOME: Route = { page: 'today' }
const TABS: readonly ProductTab[] = ['dossier', 'feed', 'sources']
const KEY = 'outpost.route'

const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value : undefined

/** A stored value as a route, with unknown fields dropped; undefined when it names no page or lacks what the page needs. */
export function parseRoute(value: unknown): Route | undefined {
  const { page, date, trackId, productId, tab, expand } = (value ?? {}) as Record<string, unknown>
  switch (page) {
    case 'today': { const day = text(date); return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? { page, date: day } : { page } }
    case 'newTrack': { const id = text(trackId); return id ? { page, trackId: id } : { page } }
    case 'addProduct': case 'editTrack': case 'track': { const id = text(trackId); return id ? { page, trackId: id } : undefined }
    case 'product': {
      const id = text(productId)
      if (!id) return undefined
      const dimension = text(expand)
      return { page, productId: id, tab: TABS.find(item => item === tab) ?? 'dossier', ...dimension ? { expand: dimension } : {} }
    }
    case 'runs': case 'settings': return { page }
    default: return undefined
  }
}

/** The route the panel opens on: the last one shown, else today's brief. Storage that is unreadable or refuses access is skipped. */
function initialRoute(): Route {
  try {
    return parseRoute(JSON.parse(globalThis.localStorage.getItem(KEY) ?? 'null')) ?? HOME
  } catch {
    return HOME
  }
}

/**
 * Remembers `route` for the next visit; a day of the brief is not kept (the panel opens on today's), nor the card a link
 * asked to open.
 */
function remember(route: Route): void {
  const kept: Route = route.page === 'today' ? { page: 'today' } : route.page === 'product' ? { page: 'product', productId: route.productId, tab: route.tab } : route
  try { globalThis.localStorage.setItem(KEY, JSON.stringify(kept)) } catch { /* Remembering the page is a convenience. */ }
}

/** The page shown, held in memory; each move is also remembered in `localStorage` (key `outpost.route`). */
export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState(initialRoute)
  const navigate = useCallback((next: Route) => { setRoute(next); remember(next) }, [])
  return [route, navigate]
}

/** Whether two routes show the same page of the same thing (tabs and cards aside). */
export function samePage(a: Route, b: Route): boolean {
  if (a.page !== b.page) return false
  if (a.page === 'product' && b.page === 'product') return a.productId === b.productId
  if (a.page === 'newTrack' && b.page === 'newTrack') return a.trackId === b.trackId
  if (a.page === 'addProduct' && b.page === 'addProduct') return a.trackId === b.trackId
  if (a.page === 'editTrack' && b.page === 'editTrack') return a.trackId === b.trackId
  if (a.page === 'track' && b.page === 'track') return a.trackId === b.trackId
  return true
}
