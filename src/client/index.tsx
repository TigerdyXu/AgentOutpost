/** Browser half of 前哨: the main panel, its sidebar entry with the unread count, and the Plugin Manager config row. */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import STYLES from './styles.css?raw'
import { call } from './api.ts'
import { en, NS, zh, type T } from './locales.ts'
import { App } from './shell/App.tsx'
import { TelescopeIcon } from './ui/icons.tsx'

type ClientContext = Context & { sessions: ISessions }
const PANEL_ID = 'outpost' as MainPanelId
/** `<package name>#<row id>` of the plugin's row in cordis.patch.yml. */
const CONFIG_ROW = 'dsh-outpost#outpost'
/** Largest count the sidebar row spells out; larger counts show as this number followed by `+`. */
const MAX_SHOWN = 99
/** How often the sidebar count reads `GET state` on its own. */
const COUNT_POLL_MS = 60_000

/** Telescope glyph at the size the sidebar asks for, drawn in the row's text color. */
function SidebarIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <TelescopeIcon size={size} />
}

/** Business face of the sidebar count: the unread count of today's brief, which the renderer binds as `useCount`. */
interface UnreadCountInjected {
  readonly hooks: { readonly count: HostObservable<number> }
}
type UnreadCountProps = PropsRuntime<'sidebar.panellist.trailing'> & InjectFace<UnreadCountInjected> & PropsLocale<typeof NS>

/**
 * The unread count at the end of the sidebar row (as DSH's review count, client-ui-forge `ReviewNav.tsx`): nothing at
 * zero; a round badge when the sidebar is collapsed; the visible number is decorative and a visually hidden sentence
 * beside it describes the row.
 */
function UnreadCount({ useCount, wide, t }: UnreadCountProps): ReactNode {
  const count = useCount(value => value)
  if (count === 0) return null
  return <span className="op-nav-count" data-wide={wide ? '' : undefined}>
    <span aria-hidden="true">{count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}</span>
    <span className="op-visually-hidden">{t('unreadAria', { count })}</span>
  </span>
}

/**
 * The sidebar count's source: `todayUnread` of `GET state`. While the sidebar shows it, it reads the state every minute
 * (not while the page is hidden; at once when it shows again); the panel hands it every state it reads (`set`), so a
 * change made there (全部已读, say) shows at once. A failed read keeps the last count.
 */
function unreadCount() {
  let value = 0
  let closed = false
  let timer: ReturnType<typeof setInterval> | undefined
  const listeners = new Set<() => void>()
  const set = (next: number) => {
    if (closed || next === value) return
    value = next
    for (const listener of [...listeners]) listener()
  }
  const read = async () => {
    try { set((await call('GET state')).todayUnread) } catch { /* The next minute asks again. */ }
  }
  const shown = () => { if (!document.hidden) void read() }
  const start = () => {
    void read()
    timer = setInterval(shown, COUNT_POLL_MS)
    document.addEventListener('visibilitychange', shown)
  }
  const stop = () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', shown)
  }
  const observable: HostObservable<number> = {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1 && !closed) start()
      return () => { if (listeners.delete(listener) && listeners.size === 0) stop() }
    },
  }
  return { observable, set, close: () => { closed = true; listeners.clear(); stop() } }
}

/** The plugin's row page in Plugin Manager; settings arrive with the settings page. */
function PluginConfig({ t }: PluginConfigViewProps & { t: T }): ReactNode {
  return t('configSummary')
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.outpost = ''
    style.textContent = STYLES
    document.head.append(style)
    return () => { style.remove() }
  }, 'dsh-outpost: stylesheet')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-outpost: dictionaries')
  const t = ctx.locale.bind(NS) as T
  const count = unreadCount()
  ctx.effect(() => () => { count.close() }, 'dsh-outpost: unread count')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS },
    (props: { t: T }) => <App t={props.t} onState={state => { count.set(state.todayUnread) }} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel'), locale: NS,
  }, SidebarIcon))
  ctx.slots.inject('sidebar.panellist.trailing', () => ctx.slots.register({
    name: 'sidebar.panellist.trailing', id: PANEL_ID, locale: NS, inject: (): UnreadCountInjected => ({ hooks: { count: count.observable } }),
  }, UnreadCount))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: CONFIG_ROW, locale: NS }, PluginConfig))
}
