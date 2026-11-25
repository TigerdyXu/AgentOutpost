/** What the shell hands every part of the panel: copy, the route, the latest `GET state`, and ways to change them. */
import { createContext, useContext } from 'react'
import type { Id } from '../../core/types.ts'
import type { StateView } from '../../host/api.ts'
import type { T } from '../locales.ts'
import type { Route } from './route.ts'

export interface Shell {
  t: T
  route: Route
  /** Shows another page in the right column (and remembers it for the next visit). */
  navigate: (route: Route) => void
  /** The latest `GET state`; undefined until the first answer. */
  state: StateView | undefined
  /** Why the last `GET state` failed, while it does (cleared by the next answer). */
  stateError: Error | undefined
  /** Reads `GET state` now, after a change the middle column or the sidebar count shows (全部已读, say). */
  refresh: () => void
  /** How many candidates the 挑产品 page has picked, by track id, while it knows (the middle column's 「已选 n」). */
  picks: Readonly<Record<Id, number>>
  /** The 挑产品 page reports its picks for a track here; null forgets them (the server's defaults show again). */
  setPicks: (trackId: Id, count: number | null) => void
}

export const ShellContext = createContext<Shell | null>(null)

/** The shell's context; every panel component renders inside it. */
export function useShell(): Shell {
  const shell = useContext(ShellContext)
  if (!shell) throw new Error('dsh-outpost: a panel component rendered outside the shell')
  return shell
}
