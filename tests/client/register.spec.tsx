// @vitest-environment jsdom
import { act, useSyncExternalStore, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../../src/client/index.tsx'
import { all, fakeCtx, settle, state, stubApi, t, type Entry } from '../fixtures/client.tsx'

/** A client context with the plugin applied. */
function fixture() {
  const fake = fakeCtx()
  apply(fake.ctx as never)
  return fake
}
const mounted: (() => void)[] = []
async function render(Component: ComponentType<Record<string, unknown>>, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<Component {...props} />) })
  const dispose = () => { act(() => { root.unmount() }); container.remove() }
  mounted.push(dispose)
  return { container, dispose }
}
/** The trailing count's props as the renderer hands them: the injected count bound as `useCount`. */
const countProps = (count: number, wide = true) => ({ useCount: <T,>(select: (value: number) => T) => select(count), wide, active: false, t })
/** The count the trailing entry injects, as the renderer reads it. */
const countOf = (entry: Entry) => (entry.options.inject!() as { hooks: { count: HostObservable<number> } }).hooks.count
/** The trailing count bound to its live observable, as the renderer binds `hooks.count`. */
function Live({ entry, wide }: { entry: Entry; wide: boolean }) {
  const count = countOf(entry)
  const value = useSyncExternalStore(count.subscribe, count.getSnapshot)
  const Count = entry.component
  return <Count useCount={<T,>(select: (value: number) => T) => select(value)} wide={wide} active={false} t={t} />
}
afterEach(() => {
  for (const dispose of mounted.splice(0)) dispose()
  document.body.innerHTML = ''; document.head.innerHTML = ''
  vi.unstubAllGlobals(); vi.useRealTimers()
})

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

it('shows the two-column panel in main and a telescope in the sidebar', async () => {
  stubApi({ 'GET state': state() })
  const { entry } = fixture()
  const main = await render(entry('main').component, { t })
  await settle()
  expect(main.container.querySelector('.op-app .op-mid .op-mid-title')?.textContent).toBe('前哨')
  expect(main.container.querySelector('.op-app .op-content')).not.toBeNull()
  const icon = await render(entry('sidebar.panellist').component, { size: 18, active: false })
  const svg = icon.container.querySelector('svg')!
  expect(svg.getAttribute('width')).toBe('18')
  expect(svg.getAttribute('aria-hidden')).toBe('true')
  // The glyph draws in the row's text color; no color literal.
  expect(svg.getAttribute('stroke')).toBe('currentColor')
})

it('trailing count renders nothing at 0 and 99+ above 99, as a round badge when the sidebar is collapsed', async () => {
  const { entry, dictionaries } = fixture()
  const style = document.head.querySelector('style[data-outpost]')!
  expect(style).not.toBeNull()
  const trailing = entry('sidebar.panellist.trailing').component
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
  expect(dictionaries).toHaveProperty('outpost')

  // Wide: plain number at the row's end. Collapsed (`wide: false`): a round blue badge on the icon.
  const wide = few.container.querySelector<HTMLElement>('.op-nav-count')!
  expect(wide.hasAttribute('data-wide')).toBe(true)
  expect(getComputedStyle(wide).borderRadius).toBe('')
  const collapsed = (await render(trailing, countProps(7, false))).container.querySelector<HTMLElement>('.op-nav-count')!
  expect(collapsed.hasAttribute('data-wide')).toBe(false)
  expect(collapsed.querySelector('[aria-hidden="true"]')?.textContent).toBe('7')
  expect(getComputedStyle(collapsed).borderRadius).toBe('999px')
  expect(getComputedStyle(collapsed).backgroundColor).toBe('var(--dsw-alias-state-business-primary)')
  expect((await render(trailing, countProps(0, false))).container.innerHTML).toBe('')
})

it('trailing count reads today’s unread every minute and whenever the panel reads the state', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  let unread = 2
  const api = stubApi({ 'GET state': () => state({ todayUnread: unread }) })
  const { entry, dispose } = fixture()
  const trailing = entry('sidebar.panellist.trailing')
  // Nothing is read before the sidebar shows the count.
  expect(api.requests).toHaveLength(0)
  await render(Live as never, { entry: trailing, wide: true })
  await settle()
  const shown = () => all('.op-nav-count [aria-hidden="true"]')[0]?.textContent
  expect(shown()).toBe('2')
  expect(api.requests).toHaveLength(1)
  unread = 5
  await act(async () => { await vi.advanceTimersByTimeAsync(59_000) })
  expect(shown()).toBe('2')
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
  await settle()
  expect(shown()).toBe('5')
  expect(api.requests).toHaveLength(2)

  // The panel reading the state (after 全部已读, say) updates the count at once; at 0 it disappears.
  unread = 0
  await render(entry('main').component, { t })
  await settle()
  expect(shown()).toBeUndefined()
  expect(api.requests).toHaveLength(3)

  // Once disposed, it stops asking.
  for (const unmount of mounted.splice(0)) unmount()
  dispose()
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
  expect(api.requests).toHaveLength(3)
})

it('injects the stylesheet while applied and removes it on dispose', () => {
  const { dispose } = fixture()
  const style = document.head.querySelector('style[data-outpost]')
  expect(style?.textContent).toContain('.op-visually-hidden')
  dispose()
  expect(document.head.querySelector('style[data-outpost]')).toBeNull()
})
