// @vitest-environment jsdom
import { act, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { apply, inject } from '../../src/client/index.tsx'
import { zh } from '../../src/client/locales.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Options = { name: string; id?: string; key?: string; order?: number; locale?: string; label?: () => string; inject?: () => unknown }
type Entry = { options: Options; component: ComponentType<Record<string, unknown>> }
/** Chinese dictionary lookup with `{name}` substitution, as the locale service's bound `t` does. */
const t = (key: keyof typeof zh, params: Record<string, unknown> = {}) => zh[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name]))

/** A client context that records slot registrations, dictionaries and effect disposers (as in superagent tests/client.spec.tsx). */
function fixture() {
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
    get: () => undefined,
  }
  apply(ctx as never)
  const entry = (name: string) => entries.find(item => item.options.name === name)!
  return { entries, dictionaries, dispose: () => { for (const dispose of disposers.splice(0)) dispose() }, entry }
}
async function render(entry: Entry, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}
/** The trailing count's props as the renderer hands them: the injected unread count bound as `useUnread`. */
const countProps = (unread: number) => ({ useUnread: <T,>(select: (value: number) => T) => select(unread), wide: true, active: false, t })
afterEach(() => { document.body.innerHTML = ''; document.head.innerHTML = '' })

it('registers main, sidebar entry, trailing count and plugin config row', () => {
  const { entries, dictionaries } = fixture()
  expect(inject).toEqual(['slots', 'locale', 'sessions', 'uiWorkspace'])
  expect(entries.map(e => e.options.name)).toEqual(['main', 'sidebar.panellist', 'sidebar.panellist.trailing', 'plugins.row.config'])
  expect(entries[0]!.options).toMatchObject({ key: 'outpost', locale: 'outpost' })
  expect(entries[1]!.options).toMatchObject({ id: 'outpost', order: 20, locale: 'outpost' })
  expect(entries[1]!.options.label?.()).toBe('前哨')
  expect(entries[2]!.options).toMatchObject({ id: 'outpost', locale: 'outpost' })
  expect(entries[3]!.options).toMatchObject({ key: 'dsh-outpost#outpost' })
  expect(Object.keys(dictionaries)).toEqual(['outpost'])
})

it('shows the 前哨 title on the main panel and a telescope in the sidebar', async () => {
  const { entry } = fixture()
  const main = await render(entry('main'), { t })
  expect(main.container.querySelector('h1')?.textContent).toBe('前哨')
  const icon = await render(entry('sidebar.panellist'), { size: 18, active: false })
  const svg = icon.container.querySelector('svg')!
  expect(svg.getAttribute('width')).toBe('18')
  expect(svg.getAttribute('aria-hidden')).toBe('true')
  // The glyph draws in the row's text color; no color literal.
  expect(svg.getAttribute('stroke')).toBe('currentColor')
})

it('trailing count renders nothing at 0 and 99+ above 99', async () => {
  const { entry } = fixture()
  const trailing = entry('sidebar.panellist.trailing')
  const none = await render(trailing, countProps(0))
  expect(none.container.innerHTML).toBe('')
  const few = await render(trailing, countProps(7))
  expect(few.container.querySelector('[aria-hidden="true"]')?.textContent).toBe('7')
  const many = await render(trailing, countProps(150))
  const shown = many.container.querySelector('[aria-hidden="true"]')
  expect(shown?.textContent).toBe('99+')
  // Screen readers hear the whole sentence with the exact count, not the decorative number.
  const sentence = many.container.querySelector('.op-visually-hidden')
  expect(sentence?.textContent).toBe(t('unreadAria', { count: 150 }))
  expect(sentence?.textContent).toContain('150')
})

it('injects the stylesheet while applied and removes it on dispose', () => {
  const { dispose } = fixture()
  const style = document.head.querySelector('style[data-outpost]')
  expect(style?.textContent).toContain('.op-visually-hidden')
  dispose()
  expect(document.head.querySelector('style[data-outpost]')).toBeNull()
})
