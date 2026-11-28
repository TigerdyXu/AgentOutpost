// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { Note } from '../../src/core/types.ts'
import { Product } from '../../src/client/pages/Product.tsx'
import { FeedTab } from '../../src/client/pages/product/FeedTab.tsx'
import { Search } from '../../src/client/pages/Search.tsx'
import { all, click, fail, find, finding, mount, product, productView, state, stubApi, type StubRequest, tEn, text, type, unmount } from '../fixtures/client.tsx'

afterEach(() => { unmount(); vi.unstubAllGlobals() })

const p = product('p1', '小豆')
const note = (kind: Note['kind'], subjectId: string, words: string): Note => ({ kind, subjectId, text: words, updatedAt: new Date(2026, 10, 28, 9).toISOString() })
/** The host's answer to a note written: what it keeps (blank erases). */
const keep = (req: StubRequest) => {
  const words = String((req.body as { text: string }).text).trim()
  return { note: words ? note(req.params.kind as Note['kind'], req.params.id!, words) : null }
}

describe('a note on a product', () => {
  it('is written from the product page, shown as the user’s, edited and erased', async () => {
    const api = stubApi({
      'GET state': state(), 'GET products/:id': productView(p), 'GET products/:id/findings': { findings: [], sources: [], changed: {}, notes: {} },
      'POST notes/:kind/:id': keep,
    })
    await mount(<Product />, { route: { page: 'product', productId: 'p1', tab: 'dossier' }, state: state() })
    await click(find('＋ 写笔记'))
    const field = document.querySelector<HTMLTextAreaElement>('.op-note textarea')!
    expect(document.activeElement).toBe(field)
    // Counted as the host counts: an emoji is one; over the limit it says so and cannot be saved.
    await type(field, '😀'.repeat(3))
    expect(text()).toContain('3/2000')
    await type(field, '长'.repeat(2001))
    expect(text()).toContain('超过 2000 字了')
    expect(find('保存').hasAttribute('disabled')).toBe(true)
    await type(field, '')
    expect(find('保存').hasAttribute('disabled')).toBe(true) // nothing to keep yet
    await type(field, '要盯它的定价')
    expect(text()).toContain('6/2000')
    await click(find('保存'))
    expect(api.requests.filter(r => r.method === 'POST').map(r => [r.path, r.body])).toEqual([['notes/product/p1', { text: '要盯它的定价' }]])
    expect(document.querySelector('.op-note-text')?.textContent).toBe('要盯它的定价')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('编辑笔记：小豆') // focus back on the note's 编辑
    expect(document.querySelector('.op-note-label')?.textContent).toBe('我的笔记')
    expect(document.querySelector('.op-note-date')?.textContent).toBe('11-28')
    await click(find('编辑'))
    expect(document.querySelector<HTMLTextAreaElement>('.op-note textarea')!.value).toBe('要盯它的定价')
    await click(find('删除笔记'))
    expect(api.requests.filter(r => r.method === 'POST').at(-1)!.body).toEqual({ text: '' })
    expect(document.querySelector('.op-note')).toBeNull()
    expect(find('＋ 写笔记')).toBeTruthy()
  })

  it('shows a note the host has, and says why one could not be kept', async () => {
    stubApi({
      'GET state': state(), 'GET products/:id': productView(p, { note: note('product', 'p1', '已有的看法') }),
      'GET products/:id/findings': { findings: [], sources: [], changed: {}, notes: {} },
      'POST notes/:kind/:id': fail(400, 'A note is at most 2000 characters'),
    })
    await mount(<Product />, { route: { page: 'product', productId: 'p1', tab: 'dossier' }, state: state(), t: tEn })
    expect(document.querySelector('.op-note-text')?.textContent).toBe('已有的看法')
    expect(document.querySelector('.op-note-label')?.textContent).toBe('My note')
    await click(find('Edit'))
    await click(find('Save'))
    expect(document.querySelector('.op-note [role="alert"]')?.textContent).toContain('A note is at most 2000 characters')
    expect(document.querySelector<HTMLTextAreaElement>('.op-note textarea')?.value).toBe('已有的看法') // still being written
  })
})

describe('a note on a finding', () => {
  it('is written from the card, Esc gives up, ⌘↩ saves', async () => {
    const api = stubApi({ 'GET state': state(), 'POST notes/:kind/:id': keep })
    await mount(<FeedTab product={p} findings={[finding('f1', 'p1')]} sources={[]} dimensions={[]} notes={{}} />)
    await click(find('写笔记'))
    let field = document.querySelector<HTMLTextAreaElement>('.op-note textarea')!
    await type(field, '先不写了')
    expect(text()).toContain('4/500')
    // Esc while an input method composes is the input method's: the note stays open.
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })) })
    expect(document.querySelector('.op-note textarea')).not.toBeNull()
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('.op-note')).toBeNull()
    expect(api.requests.filter(r => r.method === 'POST')).toEqual([])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(document.activeElement?.textContent).toBe('写笔记') // focus back on the card's 写笔记
    await click(find('写笔记'))
    field = document.querySelector<HTMLTextAreaElement>('.op-note textarea')!
    expect(field.value).toBe('') // it starts again from what is kept
    await type(field, '要跟进')
    await act(async () => { field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(api.requests.filter(r => r.method === 'POST').map(r => [r.path, r.body])).toEqual([['notes/finding/f1', { text: '要跟进' }]])
    expect(document.querySelector('.op-note-text')?.textContent).toBe('要跟进')
    expect(all('.op-card-actions button').map(b => b.textContent)).not.toContain('写笔记') // written: 编辑 is on the note
  })

  it('shows the notes the host sent', async () => {
    stubApi({ 'GET state': state() })
    await mount(<FeedTab product={p} findings={[finding('f1', 'p1'), finding('f2', 'p1')]} sources={[]} dimensions={[]} notes={{ f2: note('finding', 'f2', '这条可信') }} />)
    expect(all('.op-note-text').map(n => n.textContent)).toEqual(['这条可信'])
    expect(all('.op-card').map(card => card.querySelector('.op-card-actions')?.textContent?.includes('写笔记'))).toEqual([true, false])
  })
})

describe('a search hit in a note', () => {
  it('says it was found in the user’s note, with the words', async () => {
    stubApi({
      'GET search': {
        query: '定价', products: [{ id: 'p1', name: '小豆', company: '字节跳动', tracks: ['Personal Agent'], inNote: true, snippet: { text: '要盯它的定价', marks: [{ start: 4, end: 6 }] } }],
        tracks: [], cards: [], findings: [], topics: [], more: { products: 0, tracks: 0, cards: 0, findings: 0, topics: 0 },
      },
    })
    await mount(<Search />, { route: { page: 'search', q: '定价' } })
    expect(document.querySelector('.op-search-note-tag')?.textContent).toBe('我的笔记')
    expect(document.querySelector('.op-search-snippet')?.textContent).toBe('要盯它的定价')
  })
})
