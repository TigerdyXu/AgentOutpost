/** Browser half of 前哨: the main panel, its sidebar entry with the unread count, and the Plugin Manager config row. */
import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import STYLES from './styles.css?raw'
import { en, NS, zh } from './locales.ts'

type ClientContext = Context & { sessions: ISessions }
type T = TranslateNS<typeof NS>
const PANEL_ID = 'outpost' as MainPanelId
/** `<package name>#<row id>` of the plugin's row in cordis.patch.yml. */
const CONFIG_ROW = 'dsh-outpost#outpost'
/** Largest count the sidebar row spells out; larger counts show as this number followed by `+`. */
const MAX_SHOWN = 99

/** Telescope glyph at the size the sidebar asks for, drawn in the row's text color (after Lucide's `telescope`, ISC). */
function TelescopeIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m10.065 12.493-6.18 1.318a.934.934 0 0 1-1.108-.702l-.537-2.15a1.07 1.07 0 0 1 .691-1.265l13.504-4.44" />
    <path d="m13.56 11.747 4.332-.924" />
    <path d="m16 21-3.105-6.21" />
    <path d="M16.485 5.94a2 2 0 0 1 1.455-2.425l1.09-.272a1 1 0 0 1 1.212.727l1.515 6.06a1 1 0 0 1-.727 1.213l-1.09.272a2 2 0 0 1-2.425-1.455z" />
    <path d="m6.158 8.633 1.114 4.456" />
    <path d="m8 21 3.105-6.21" />
    <circle cx="12" cy="13" r="2" />
  </svg>
}

/** Business face of the sidebar count: the unread count of today's brief, which the renderer binds as `useUnread`. */
interface UnreadCountInjected {
  readonly hooks: { readonly unread: HostObservable<number> }
}
type UnreadCountProps = PropsRuntime<'sidebar.panellist.trailing'> & InjectFace<UnreadCountInjected> & PropsLocale<typeof NS>

/**
 * The unread count at the end of the sidebar row (as DSH's review count, client-ui-forge `ReviewNav.tsx`): nothing at
 * zero; the visible number is decorative and a visually hidden sentence beside it describes the row.
 */
function UnreadCount({ useUnread, wide, t }: UnreadCountProps): ReactNode {
  const count = useUnread(value => value)
  if (count === 0) return null
  return <span className="op-nav-count" data-wide={wide ? '' : undefined}>
    <span aria-hidden="true">{count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}</span>
    <span className="op-visually-hidden">{t('unreadAria', { count })}</span>
  </span>
}

/** The main panel; this skeleton shows only its title. */
function Main({ t }: { t: T }): ReactNode {
  return <div className="op-app"><h1 className="op-title">{t('panel')}</h1></div>
}

/** The plugin's row page in Plugin Manager; settings arrive with the settings page. */
function PluginConfig({ t }: PluginConfigViewProps & { t: T }): ReactNode {
  return t('configSummary')
}

/** Unread count source. Nothing is tracked yet, so it stays at zero. */
const unread: HostObservable<number> = { getSnapshot: () => 0, subscribe: () => () => {} }

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
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Main))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel'), locale: NS,
  }, TelescopeIcon))
  ctx.slots.inject('sidebar.panellist.trailing', () => ctx.slots.register({
    name: 'sidebar.panellist.trailing', id: PANEL_ID, locale: NS, inject: (): UnreadCountInjected => ({ hooks: { unread } }),
  }, UnreadCount))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: CONFIG_ROW, locale: NS }, PluginConfig))
}
