// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import STYLES from '../../src/client/styles.css?raw'
import { Citation } from '../../src/client/ui/Citation.tsx'
import { ProductIcon } from '../../src/client/ui/ProductIcon.tsx'
import { SourceChip } from '../../src/client/ui/SourceChip.tsx'
import { Tag, TAG_KINDS } from '../../src/client/ui/Tag.tsx'
import type { Source } from '../../src/core/types.ts'
import { all, mount, product, unmount } from '../fixtures/client.tsx'

afterEach(() => { unmount(); document.head.innerHTML = '' })

const source = (extra: Partial<Source> = {}): Source => ({
  id: 's1', url: 'https://mp.weixin.qq.com/s/abc', title: '豆包·小豆全量开放', publisher: '豆包官方公众号', publishedAt: '2026-11-25',
  kind: 'official', isOfficial: true, quote: '即日起，小豆对全部安卓用户开放。', syndicationGroup: null, openedVia: 'browser', quoteFound: true, officialConfirmed: true,
  supportsClaim: true, ...extra,
})
/** Puts the stylesheet in the document so computed styles follow its rules. */
const styled = () => { const style = document.createElement('style'); style.textContent = STYLES; document.head.append(style) }
const hover = (element: Element, type: 'mouseover' | 'mouseout') => act(() => { element.dispatchEvent(new MouseEvent(type, { bubbles: true })) })

it('shows a uniform tile when a product has no icon', async () => {
  styled()
  await mount(<>
    <ProductIcon product={product('p1', 'Meta Muse')} size={20} />
    <ProductIcon product={product('p2', '豆包·小豆')} size={44} />
    <ProductIcon product={product('p3', '  ray-ban')} />
  </>)
  const tiles = all('.op-icon')
  expect(tiles.map(tile => tile.textContent)).toEqual(['M', '豆', 'R'])
  expect(all('img')).toHaveLength(0)
  // One color for every product, from the theme: the tile takes only its size from the element, never a color.
  for (const tile of tiles) {
    expect(tile.getAttribute('style')).toMatch(/^--op-icon-size: \d+px;?$/)
    expect(tile.getAttribute('aria-hidden')).toBe('true')
    expect(getComputedStyle(tile).backgroundColor).toBe('var(--dsw-alias-state-business-tertiary)')
    expect(getComputedStyle(tile).color).toBe('var(--dsw-alias-link)')
  }
  expect(tiles[1]!.getAttribute('style')).toContain('44px')
})

it('falls back to the tile when the icon fails to load', async () => {
  await mount(<ProductIcon product={product('p 1', 'Meta Muse', { iconPath: 'icons/p1.png' })} size={20} />)
  const img = document.querySelector('img')!
  expect(img.getAttribute('src')).toBe('/outpost/api/icons/p%201')
  expect(img.getAttribute('alt')).toBe('')
  expect(img.getAttribute('width')).toBe('20')
  await act(async () => { img.dispatchEvent(new Event('error')) })
  expect(document.querySelector('img')).toBeNull()
  expect(document.querySelector('.op-icon')?.textContent).toBe('M')
})

it('shows the source quote on citation hover', async () => {
  await mount(<p>11-25 起对全部安卓用户开放<Citation n={3} source={source()} /></p>)
  const link = document.querySelector<HTMLAnchorElement>('sup a')!
  expect(link.textContent).toBe('[3]')
  // A click opens the original page in a new window.
  expect(link.getAttribute('href')).toBe('https://mp.weixin.qq.com/s/abc')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  // Hovering shows the title, the publisher and date, and the sentence quoted from it.
  await hover(link, 'mouseover')
  const card = document.querySelector('[role="tooltip"]')!
  expect(card.querySelector('.op-cite-title')?.textContent).toBe('豆包·小豆全量开放')
  expect(card.querySelector('.op-cite-meta')?.textContent).toBe('豆包官方公众号 · 2026-11-25')
  expect(card.querySelector('.op-cite-quote')?.textContent).toBe('「即日起，小豆对全部安卓用户开放。」')
  expect(link.getAttribute('aria-describedby')).toBe(card.id)
  await hover(link, 'mouseout')
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
  // Keyboard focus shows it too.
  await act(async () => { link.focus() })
  expect(document.querySelector('[role="tooltip"]')).not.toBeNull()
  await act(async () => { link.blur() })
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})

it('writes a bare [n] when the cited source is missing, and leaves out an empty date and quote', async () => {
  await mount(<p>甲<Citation n={1} source={undefined} />乙<Citation n={2} source={source({ publishedAt: null, quote: '' })} /></p>)
  const [missing, undated] = all('sup')
  expect(missing!.textContent).toBe('[1]')
  expect(missing!.querySelector('a')).toBeNull()
  await hover(undated!.querySelector('a')!, 'mouseover')
  expect(document.querySelector('.op-cite-meta')?.textContent).toBe('豆包官方公众号')
  expect(document.querySelector('.op-cite-quote')).toBeNull()
})

it('labels each tag kind with the design’s words', async () => {
  await mount(<>{TAG_KINDS.map(kind => <Tag key={kind} kind={kind} />)}</>)
  expect(all('.op-tag').map(tag => [tag.dataset.kind, tag.textContent])).toEqual([
    ['official', '官方'], ['inference', '推论'], ['ai', 'AI 归纳'], ['fresh', '今天改过'], ['unconfirmed', '待确认'],
    ['unopened', '原文打不开'], ['late', '迟到'], ['major', '重要'], ['notable', '值得留意'], ['promoted', '已证实'], ['unchecked', 'AI 整理 · 未核查'],
  ])
})

it('shows a source chip with its publisher and date, marking official and unreachable sources', async () => {
  const thisYear = new Date().getFullYear()
  await mount(<>
    <SourceChip source={source({ publishedAt: `${thisYear}-11-25` })} n={1} />
    <SourceChip source={source({ id: 's3', publishedAt: `${thisYear - 1}-03-02`, isOfficial: false, officialConfirmed: false })} />
    <SourceChip source={source({ id: 's2', isOfficial: false, kind: 'media', publisher: '36氪', publishedAt: null, openedVia: 'unopened', quoteFound: null, officialConfirmed: null })} />
  </>)
  const [official, lastYear, unopened] = all<HTMLAnchorElement>('a.op-source')
  // A date of this year shows as month-day; an older one keeps its year.
  expect(official!.textContent).toBe('[1]豆包官方公众号 · 11-25官方')
  expect(lastYear!.textContent).toBe(`豆包官方公众号 · ${thisYear - 1}-03-02`)
  expect(official!.querySelector('.op-tag')?.textContent).toBe('官方')
  expect(official!.getAttribute('href')).toBe('https://mp.weixin.qq.com/s/abc')
  expect(official!.getAttribute('target')).toBe('_blank')
  expect(official!.getAttribute('title')).toBe('豆包·小豆全量开放')
  expect(unopened!.textContent).toBe('36氪原文打不开')
  expect([...unopened!.querySelectorAll<HTMLElement>('.op-tag')].map(tag => tag.dataset.kind)).toEqual(['unopened'])
})

it('marks a source 官方 only when the check agreed that the maker published it (M1.6)', async () => {
  await mount(<>
    <SourceChip source={source()} />
    <SourceChip source={source({ id: 's2', officialConfirmed: false })} />
    <SourceChip source={source({ id: 's3', officialConfirmed: null })} />
  </>)
  const marked = all('a.op-source').map(chip => [...chip.querySelectorAll<HTMLElement>('.op-tag')].some(tag => tag.dataset.kind === 'official'))
  expect(marked).toEqual([true, false, false]) // whoever handed them in called all three official: the check decides
})

it('styles with theme variables only: no color literals, hairline borders, selection without a side bar', () => {
  const css = STYLES.replace(/\/\*[\s\S]*?\*\//g, '')
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  expect(css).not.toMatch(/\b(rgba?|hsla?|oklch|lab|lch)\(/i)
  expect(css).not.toMatch(/:\s*(white|black)\b/i)
  // Neutral borders are 0.5px hairlines.
  for (const [, width] of css.matchAll(/border(?:-\w+)?:\s*([\d.]+px)[^;]*var\(--dsw-alias-border/g)) expect(width).toBe('0.5px')
  // Text uses the theme's font; reading text is at least 15px.
  expect(css).toContain('font-family: var(--dsw-font-family)')
  expect(css).toContain('max(15px, var(--dsh-content-font-size))')
  // The selected row: light blue, blue, bold; no bar at its side.
  const selected = /\.op-row\[aria-current="page"\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  expect(selected).toContain('background: var(--dsw-alias-state-business-tertiary)')
  expect(selected).toContain('color: var(--dsw-alias-link)')
  expect(selected).toMatch(/font-weight: (600|700)/)
  expect(css).not.toMatch(/border-left:\s*[1-9]/)
  expect(css).not.toMatch(/inset\s+[1-9]\d*px\s+0\s+0/)
})
