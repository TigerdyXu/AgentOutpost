/** What the shell hands every part of the panel: copy, the route, the latest `GET state`, and ways to change them. */
import { createContext, useContext } from 'react'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Id } from '../../core/types.ts'
import type { StateView } from '../../host/api.ts'
import type { T } from '../locales.ts'
import type { Route } from './route.ts'

/** DSH's session catalog and its workspace: what opening a session there (追问) needs. */
export interface SessionAccess {
  catalog: Pick<ISessions, 'list' | 'refresh'>
  open: (id: SessionId) => void
}

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
  /** DSH's sessions, to open one in the workspace; absent when the panel runs without them (the page then says so). */
  sessions?: SessionAccess
  /** DSH's configuration form of this plugin's entry (the volatile fields), for 设置; absent when DSH has no form for it (the page then only shows). */
  configForm?: ConfigPageForm | undefined
}

export const ShellContext = createContext<Shell | null>(null)

/** The shell's context; every panel component renders inside it. */
export function useShell(): Shell {
  const shell = useContext(ShellContext)
  if (!shell) throw new Error('dsh-outpost: a panel component rendered outside the shell')
  return shell
}
