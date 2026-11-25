import { describe, expect, it } from 'vitest'
import { applyCardEdit, isFresh } from '../../src/core/cards.ts'
import type { CardVersion } from '../../src/core/types.ts'

// Dates come from local components, so the cases mean the same thing in every time zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms)
const now = at(2026, 11, 25, 15, 48)

type Edit = Parameters<typeof applyCardEdit>[1]
const edit = (body: string, over: Partial<Edit> = {}): Edit => ({
  productId: 'p',
  dimension: 'pricing',
  summary: '一句话',
  bullets: ['要点一', '要点二'],
  body,
  sourceIds: ['s1'],
  inferenceSpans: [],
  changeNote: '新增一段',
  findingIds: ['f1'],
  ...over,
})

describe('applyCardEdit', () => {
  it('records the inserted range of an edit and none for a first version', () => {
    const v1 = applyCardEdit(null, edit('甲乙'), now)
    expect(v1.addedSpans).toEqual([])
    const v2 = applyCardEdit(v1, edit('甲新乙'), now)
    expect(v2.version).toBe(2)
    expect(v2.addedSpans).toEqual([{ start: 1, end: 2 }])
  })

  it('starts at version 1 and counts up from the previous version', () => {
    const v1 = applyCardEdit(null, edit('甲'), now)
    expect(v1.version).toBe(1)
    const v2 = applyCardEdit(v1, edit('甲乙'), now)
    const v3 = applyCardEdit(v2, edit('甲乙丙'), now)
    expect(v3.version).toBe(3)
    // Also when the previous version is not the first one ever stored.
    expect(applyCardEdit({ ...v1, version: 7 }, edit('甲乙'), now).version).toBe(8)
  })

  it('carries the edit over to the new version and stamps it with the time', () => {
    const inference = [{ start: 0, end: 1 }]
    const v = applyCardEdit(null, edit('甲乙', { inferenceSpans: inference }), now)
    expect(v).toEqual({
      productId: 'p',
      dimension: 'pricing',
      version: 1,
      summary: '一句话',
      bullets: ['要点一', '要点二'],
      body: '甲乙',
      sourceIds: ['s1'],
      inferenceSpans: [{ start: 0, end: 1 }],
      addedSpans: [],
      changeNote: '新增一段',
      findingIds: ['f1'],
      createdAt: now.toISOString(),
    } satisfies CardVersion)
  })

  it('does not share its arrays with the edit it was made from', () => {
    const e = edit('甲乙', { inferenceSpans: [{ start: 0, end: 1 }] })
    const v = applyCardEdit(null, e, now)
    e.bullets.push('后来加的')
    e.sourceIds.push('s9')
    e.findingIds.push('f9')
    e.inferenceSpans[0]!.end = 2
    expect(v.bullets).toEqual(['要点一', '要点二'])
    expect(v.sourceIds).toEqual(['s1'])
    expect(v.findingIds).toEqual(['f1'])
    expect(v.inferenceSpans).toEqual([{ start: 0, end: 1 }])
  })

  it('marks every separate insertion, with offsets into the new body', () => {
    const v1 = applyCardEdit(null, edit('今天发布了产品'), now)
    const v2 = applyCardEdit(v1, edit('今天正式发布了新产品，价格下调'), now)
    expect(v2.addedSpans.map((s) => v2.body.slice(s.start, s.end)).join('|')).toBe('正式|新|，价格下调')
    expect(v2.addedSpans).toEqual([
      { start: 2, end: 4 },
      { start: 7, end: 8 },
      { start: 10, end: 15 },
    ])
  })

  it('marks the replacement but not the removed text when a passage is rewritten', () => {
    const v1 = applyCardEdit(null, edit('月费 30 元起'), now)
    const v2 = applyCardEdit(v1, edit('月费 25 元起'), now)
    expect(v2.addedSpans).toEqual([{ start: 3, end: 5 }])
    expect(v2.body.slice(3, 5)).toBe('25')
  })

  it('marks text added at the very start and at the very end', () => {
    const v1 = applyCardEdit(null, edit('中间'), now)
    const v2 = applyCardEdit(v1, edit('开头中间结尾'), now)
    expect(v2.addedSpans).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ])
  })

  it('has no added spans when the body did not change or only shrank', () => {
    const v1 = applyCardEdit(null, edit('甲乙丙丁'), now)
    expect(applyCardEdit(v1, edit('甲乙丙丁', { summary: '改了摘要' }), now).addedSpans).toEqual([])
    expect(applyCardEdit(v1, edit('甲丁'), now).addedSpans).toEqual([])
    expect(applyCardEdit(v1, edit(''), now).addedSpans).toEqual([])
  })

  it('does not highlight an old version when the edit goes from an empty body to text', () => {
    const v1 = applyCardEdit(null, edit(''), now)
    expect(applyCardEdit(v1, edit('新内容'), now).addedSpans).toEqual([{ start: 0, end: 3 }])
  })

  it('counts offsets the way String.slice does, also past emoji (two UTF-16 units each)', () => {
    const v1 = applyCardEdit(null, edit('😀甲😀乙'), now)
    const v2 = applyCardEdit(v1, edit('😀甲新😀乙'), now)
    expect(v2.addedSpans).toEqual([{ start: 3, end: 4 }])
    const s = v2.addedSpans[0]!
    expect(v2.body.slice(s.start, s.end)).toBe('新')
  })

  it('highlights only text that is new: cut out, what is left is the old body, in order', () => {
    const pairs: [string, string][] = [
      ['', '全新的一段'],
      ['价格 30 元，支持安卓', '价格 25 元，支持安卓和 iOS，新增网页版'],
      ['甲乙丙丁戊', '己甲庚乙丙辛丁戊壬'],
      ['abcabcabc', 'abXcabcYabc'],
      ['😀甲😀乙', '新😀甲😀丙乙'],
    ]
    for (const [before, after] of pairs) {
      const v1 = applyCardEdit(null, edit(before), now)
      const v2 = applyCardEdit(v1, edit(after), now)
      let rest = ''
      let pos = 0
      for (const s of v2.addedSpans) {
        expect(s.start).toBeGreaterThanOrEqual(pos)
        expect(s.end).toBeGreaterThan(s.start)
        rest += after.slice(pos, s.start)
        pos = s.end
      }
      rest += after.slice(pos)
      // `rest` is the part of the new body that was already there: every character of it is in the old body, in order.
      let at = 0
      for (const ch of rest) {
        at = before.indexOf(ch, at)
        expect(at, `"${ch}" of "${rest}" in "${before}"`).toBeGreaterThanOrEqual(0)
        at += ch.length
      }
    }
  })

  it('keeps the highlight of the latest edit only, not that of earlier versions', () => {
    const v1 = applyCardEdit(null, edit('甲乙'), now)
    const v2 = applyCardEdit(v1, edit('甲新乙'), now)
    const v3 = applyCardEdit(v2, edit('甲新乙旧'), now)
    expect(v3.addedSpans).toEqual([{ start: 3, end: 4 }])
  })

  it('leaves the previous version untouched', () => {
    const v1 = applyCardEdit(null, edit('甲乙'), now)
    const copy = structuredClone(v1)
    applyCardEdit(v1, edit('甲新乙'), now)
    expect(v1).toEqual(copy)
  })
})

describe('isFresh', () => {
  const card = (createdAt: string): CardVersion => ({ productId: 'p', dimension: 'd', version: 1, summary: '', bullets: [], body: '', sourceIds: [], inferenceSpans: [], addedSpans: [], changeNote: '', findingIds: [], createdAt })
  const made = at(2026, 11, 22, 12, 0)

  it('is fresh just after the edit and a day later', () => {
    expect(isFresh(card(made.toISOString()), made)).toBe(true)
    expect(isFresh(card(made.toISOString()), at(2026, 11, 23, 12, 0))).toBe(true)
  })

  it('stays fresh through the 72nd hour and is stale after it', () => {
    expect(isFresh(card(made.toISOString()), at(2026, 11, 25, 11, 59, 59, 999))).toBe(true)
    expect(isFresh(card(made.toISOString()), at(2026, 11, 25, 12, 0))).toBe(true)
    expect(isFresh(card(made.toISOString()), at(2026, 11, 25, 12, 0, 0, 1))).toBe(false)
    expect(isFresh(card(made.toISOString()), at(2026, 11, 30, 12, 0))).toBe(false)
  })

  it('counts 72 hours of elapsed time, not three calendar days', () => {
    // Made late on the 22nd: three calendar days later is the 25th, but only a little over 48 hours have passed.
    const late = at(2026, 11, 22, 23, 0)
    expect(isFresh(card(late.toISOString()), at(2026, 11, 25, 22, 0))).toBe(true)
    expect(isFresh(card(late.toISOString()), at(2026, 11, 26, 0, 0))).toBe(false)
  })

  it('treats an edit stamped a little in the future (clock skew) as fresh, and an unreadable stamp as not fresh', () => {
    expect(isFresh(card(at(2026, 11, 25, 15, 50).toISOString()), now)).toBe(true)
    expect(isFresh(card('not a date'), now)).toBe(false)
    expect(isFresh(card(''), now)).toBe(false)
  })
})
