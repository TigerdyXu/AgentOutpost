// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { SearchResults } from '../../src/host/search.ts'
import { Search } from '../../src/client/pages/Search.tsx'
import { FeedTab } from '../../src/client/pages/product/FeedTab.tsx'
import { MiddleColumn, SEARCH_DEBOUNCE_MS } from '../../src/client/shell/MiddleColumn.tsx'
import { parseRoute } from '../../src/client/shell/route.ts'
import { all, click, finding, mount, product, settle, state, stubApi, tEn, text, type, unmount } from '../fixtures/client.tsx'

afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals() })

const results = (over: Partial<SearchResults> = {}): SearchResults => ({
  query: '会员', products: [], tracks: [], cards: [], findings: [], topics: [],
  more: { products: 0, tracks: 0, cards: 0, findings: 0, topics: 0 }, ...over,
})
const found = results({
  cards: [{ productId: 'p1', product: '豆包·小豆', dimension: 'business', label: '商业化', snippet: { text: '…三档会员，额度互通', marks: [{ start: 3, end: 5 }] } }],
  findings: [
    { id: 'f1', productId: 'p1', product: '豆包·小豆', date: '2026-11-27', headline: '会员涨价', status: 'unconfirmed', inHeadline: true, snippet: { text: '会员涨价', marks: [{ start: 0, end: 2 }] } },
    { id: 'f2', productId: 'p2', product: 'Muse', date: '2026-11-26', headline: 'Muse 调价', status: 'verified', inHeadline: false, snippet: { text: '只给会员', marks: [{ start: 2, end: 4 }] } },
  ],
  more: { products: 0, tracks: 0, cards: 0, findings: 5, topics: 0 },
})

describe('the search page', () => {
  it('lists what was found by kind, with the words marked, and opens a card expanded or a finding on the feed', async () => {
    const api = stubApi({ 'GET search': found })
    const shell = await mount(<Search />, { route: { page: 'search', q: '会员' } })
    expect(api.requests.map(r => [r.path, r.query])).toEqual([['search', { q: '会员' }]])
    expect(document.querySelector('h1')?.textContent).toBe('搜索「会员」')
    expect(text()).toContain('找到 8 处')
    expect(all('.op-search-group-title').map(h => h.textContent)).toEqual(['档案1', '动态7'])
    expect(all('mark').map(m => m.textContent)).toEqual(['会员', '会员', '会员'])
    expect(text()).toContain('还有 5 处没列出')
    // A finding found in why it matters still shows its headline; one found in its headline does not repeat it.
    expect(all('.op-search-headline').map(h => h.textContent)).toEqual(['Muse 调价'])
    expect(all('.op-search-list .op-tag').map(tag => tag.textContent)).toEqual(['待确认'])
    await click(all('.op-search-hit')[0]!)
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p1', tab: 'dossier', expand: 'business' })
    await click(all('.op-search-hit')[2]!)
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'product', productId: 'p2', tab: 'feed', finding: 'f2' })
  })

  it('says how to search before anything is typed, and when nothing is found, in English too', async () => {
    const api = stubApi({ 'GET search': results({ query: 'zzz' }) })
    await mount(<Search />, { route: { page: 'search', q: '' } })
    expect(api.requests).toEqual([])
    expect(text()).toContain('在左边的搜索框里输入要找的词')
    unmount()
    await mount(<Search />, { route: { page: 'search', q: 'zzz' }, t: tEn })
    expect(text()).toContain('Nothing in Outpost matches “zzz”.')
    unmount()
    stubApi({ 'GET search': results({ query: 'muse', products: [{ id: 'p2', name: 'Muse', company: 'Meta', tracks: ['Personal Agent'], snippet: { text: 'Muse', marks: [{ start: 0, end: 4 }] } }] }) })
    await mount(<Search />, { route: { page: 'search', q: 'muse' }, t: tEn })
    expect(text()).toContain('1 match')
    expect(text()).toContain('Meta · Personal Agent')
  })
})

describe('the search box', () => {
  it('shows the results once typing pauses, at once on Enter, and empties on Esc', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    stubApi({ 'GET state': state() })
    const onChoose = vi.fn()
    const shell = await mount(<MiddleColumn onChoose={onChoose} />, { state: state() })
    const box = document.querySelector<HTMLInputElement>('.op-mid-search-input')!
    expect(box.placeholder).toBe('搜索前哨')
    await type(box, '小')
    await type(box, '小豆 ')
    expect(shell.navigate).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
    expect(shell.navigate).toHaveBeenCalledOnce()
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'search', q: '小豆' }, { keepColumn: true })
    await type(box, '小豆 会员')
    await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'search', q: '小豆 会员' }, { keepColumn: false })
    expect(onChoose).toHaveBeenCalledOnce()
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
    expect(shell.navigate).toHaveBeenCalledTimes(2) // Enter went at once; the pause after it adds nothing
    await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(box.value).toBe('')
  })

  it('keeps the narrow layout’s column open while results follow the typing; Enter closes it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    stubApi({ 'GET state': state() })
    const shell = await mount(<MiddleColumn />, { state: state() })
    const box = document.querySelector<HTMLInputElement>('.op-mid-search-input')!
    await type(box, '会员')
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'search', q: '会员' }, { keepColumn: true })
    await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'search', q: '会员' }, { keepColumn: false })
  })

  it('searches nothing while an input method composes, and once it is done', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    stubApi({ 'GET state': state() })
    const shell = await mount(<MiddleColumn />, { state: state() })
    const box = document.querySelector<HTMLInputElement>('.op-mid-search-input')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      box.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      setter.call(box, 'hui yuan')
      box.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 4) })
    expect(shell.navigate).not.toHaveBeenCalled()
    await act(async () => {
      setter.call(box, '会员')
      box.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
      box.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '会员' }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
    expect(shell.navigate).toHaveBeenCalledOnce()
    expect(shell.navigate).toHaveBeenLastCalledWith({ page: 'search', q: '会员' }, { keepColumn: true })
  })

  it('drops a search still due when Esc empties the box or another page opens first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    stubApi({ 'GET state': state() })
    const shell = await mount(<MiddleColumn />, { state: state() })
    const box = document.querySelector<HTMLInputElement>('.op-mid-search-input')!
    await type(box, 'a')
    await act(async () => { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS) })
    expect(shell.navigate).not.toHaveBeenCalled()
    expect(box.value).toBe('')
  })

  it('shows the search page’s words, and is emptied when another page opens', async () => {
    stubApi({ 'GET state': state() })
    await mount(<MiddleColumn />, { state: state(), route: { page: 'search', q: '会员' } })
    expect(document.querySelector<HTMLInputElement>('.op-mid-search-input')!.value).toBe('会员')
    await mount(<MiddleColumn />, { state: state(), route: { page: 'runs' } })
    expect(document.querySelector<HTMLInputElement>('.op-mid-search-input')!.value).toBe('')
  })
})

describe('a finding a search hit opened', () => {
  it('is outlined and scrolled to, its fold opened when it is one that expired', async () => {
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push((this as HTMLElement).dataset.finding ?? '') }
    const p = product('p1', '小豆')
    const findings = [finding('f1', 'p1'), finding('f2', 'p1', { status: 'unproven' })]
    await mount(<FeedTab product={p} findings={findings} sources={[]} dimensions={[]} focus="f2" />)
    await settle()
    expect(all('[data-focused]').map(card => card.getAttribute('data-finding'))).toEqual(['f2'])
    expect(scrolled.at(-1)).toBe('f2')
    expect(text()).toContain('收起')
    // Folding it again is the reader's choice now, and the page does not jump back to the finding.
    await click(all('.op-fold')[0]!)
    expect(text()).not.toContain('收起')
    await click(all('.op-fold')[0]!)
    expect(scrolled).toEqual(['f2'])
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  })
})

describe('the routes', () => {
  it('reads a search and a finding to open', () => {
    expect(parseRoute({ page: 'search', q: '会员' })).toEqual({ page: 'search', q: '会员' })
    expect(parseRoute({ page: 'search' })).toEqual({ page: 'search', q: '' })
    expect(parseRoute({ page: 'product', productId: 'p1', tab: 'feed', finding: 'f1' })).toEqual({ page: 'product', productId: 'p1', tab: 'feed', finding: 'f1' })
  })
})
