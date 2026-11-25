import { describe, expect, it } from 'vitest'
import { composeBrief, NO_NEWS_GIST, unreadCount } from '../../src/core/brief.ts'
import type { Brief, Finding } from '../../src/core/types.ts'

// Dates come from local components, so the cases mean the same thing in every time zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms)
const now = at(2026, 11, 25, 8, 30)
const stamp = (h: number, mi = 0) => at(2026, 11, 25, h, mi).toISOString()

let seq = 0
const finding = (over: Partial<Finding> = {}): Finding => {
  const id = over.id ?? `f${++seq}`
  return {
    id,
    productId: 'p1',
    runId: 'r1',
    headline: `标题 ${id}`,
    why: '为什么重要',
    importance: 'notable',
    claimKind: 'self',
    sourceIds: ['s1'],
    status: 'verified',
    statusNote: null,
    unconfirmedUntil: null,
    dimensions: [],
    inference: false,
    read: false,
    late: false,
    dedupeKey: `k-${id}`,
    verifiedOn: null,
    createdAt: stamp(7, 0),
    ...over,
  }
}

const base = { date: '2026-11-25', findings: [] as Finding[], trackedProductIds: ['p1', 'p2', 'p3'], skipped: [] as Brief['skipped'], gist: '今天有 3 条变化', costYuan: 1.5, now, previous: null as Brief | null }

describe('composeBrief', () => {
  it('puts major before notable and verified before unconfirmed', () => {
    const findings = [
      finding({ id: 'n-unconf', importance: 'notable', status: 'unconfirmed', createdAt: stamp(6) }),
      finding({ id: 'n-ver', importance: 'notable', status: 'verified', createdAt: stamp(7) }),
      finding({ id: 'm-unconf', importance: 'major', status: 'unconfirmed', createdAt: stamp(5) }),
      finding({ id: 'm-ver', importance: 'major', status: 'verified', createdAt: stamp(8) }),
    ]
    const brief = composeBrief({ ...base, findings })
    // Importance first, then verified ahead of unconfirmed, whatever the creation times are.
    expect(brief.findingIds).toEqual(['m-ver', 'm-unconf', 'n-ver', 'n-unconf'])
  })

  it('orders findings of the same importance and status by creation time, earliest first', () => {
    const findings = [
      finding({ id: 'c', createdAt: stamp(9, 5) }),
      finding({ id: 'a', createdAt: stamp(6, 30) }),
      finding({ id: 'b', createdAt: stamp(7, 45) }),
    ]
    expect(composeBrief({ ...base, findings }).findingIds).toEqual(['a', 'b', 'c'])
    // The order does not depend on the order they come in.
    expect(composeBrief({ ...base, findings: [...findings].reverse() }).findingIds).toEqual(['a', 'b', 'c'])
  })

  it('compares creation times as moments in time, not as text', () => {
    // Same instant written in two zones sorts by the instant: 09:00+08:00 is 01:00Z, earlier than 02:00Z.
    const findings = [finding({ id: 'late', createdAt: '2026-11-25T02:00:00.000Z' }), finding({ id: 'early', createdAt: '2026-11-25T09:00:00.000+08:00' })]
    expect(composeBrief({ ...base, findings }).findingIds).toEqual(['early', 'late'])
  })

  it('folds minor findings and names quiet products', () => {
    const findings = [
      finding({ id: 'big', productId: 'p1', importance: 'major' }),
      finding({ id: 'small', productId: 'p2', importance: 'minor' }),
    ]
    const brief = composeBrief({ ...base, findings })
    expect(brief.findingIds).toEqual(['big'])
    expect(brief.minorIds).toEqual(['small'])
    // p2 only had a minor finding: that is still news about it, so only p3 is quiet.
    expect(brief.quietProductIds).toEqual(['p3'])
  })

  it('orders the folded minor findings like the rest: verified first, then creation time', () => {
    const findings = [
      finding({ id: 'm3', importance: 'minor', status: 'unconfirmed', createdAt: stamp(6) }),
      finding({ id: 'm2', importance: 'minor', createdAt: stamp(8) }),
      finding({ id: 'm1', importance: 'minor', createdAt: stamp(7) }),
    ]
    expect(composeBrief({ ...base, findings }).minorIds).toEqual(['m1', 'm2', 'm3'])
  })

  it('uses the no-news gist when nothing happened', () => {
    expect(NO_NEWS_GIST).toBe('今天没有值得看的变化')
    const brief = composeBrief({ ...base, findings: [], gist: NO_NEWS_GIST })
    expect(brief.findingIds).toEqual([])
    expect(brief.minorIds).toEqual([])
    expect(brief.gist).toBe(NO_NEWS_GIST)
    // Nobody is padded in: every tracked product is named as quiet.
    expect(brief.quietProductIds).toEqual(['p1', 'p2', 'p3'])
  })

  it('writes the no-news gist itself when nothing is left to show, whatever gist it was given', () => {
    const none = composeBrief({ ...base, findings: [], gist: '今天有 3 条变化' })
    expect(none.gist).toBe(NO_NEWS_GIST)
    // Everything found was withdrawn after checking: still nothing to show.
    const withdrawnOnly = composeBrief({ ...base, findings: [finding({ status: 'withdrawn' }), finding({ status: 'unproven' })], gist: '今天有 3 条变化' })
    expect(withdrawnOnly.gist).toBe(NO_NEWS_GIST)
    expect(withdrawnOnly.findingIds).toEqual([])
  })

  it('keeps the given gist when there is something to show, even if it is only minor', () => {
    expect(composeBrief({ ...base, findings: [finding({ importance: 'major' })], gist: '甲发布了新版本' }).gist).toBe('甲发布了新版本')
    expect(composeBrief({ ...base, findings: [finding({ importance: 'minor' })], gist: '只有小动静' }).gist).toBe('只有小动静')
  })

  it('never includes withdrawn, pending or unproven findings', () => {
    const findings = [
      finding({ id: 'ok-v', status: 'verified' }),
      finding({ id: 'ok-u', status: 'unconfirmed' }),
      finding({ id: 'x-w', status: 'withdrawn', importance: 'major' }),
      finding({ id: 'x-p', status: 'pending', importance: 'major' }),
      finding({ id: 'x-n', status: 'unproven', importance: 'major' }),
      finding({ id: 'x-wm', status: 'withdrawn', importance: 'minor' }),
      finding({ id: 'x-pm', status: 'pending', importance: 'minor' }),
    ]
    const brief = composeBrief({ ...base, findings })
    expect(brief.findingIds).toEqual(['ok-v', 'ok-u'])
    expect(brief.minorIds).toEqual([])
    for (const id of ['x-w', 'x-p', 'x-n', 'x-wm', 'x-pm']) expect([...brief.findingIds, ...brief.minorIds]).not.toContain(id)
  })

  it('counts a tracked product with only unshown findings as quiet, since nothing of it shows', () => {
    const findings = [
      finding({ productId: 'p1', status: 'withdrawn' }),
      finding({ productId: 'p2', status: 'unproven', importance: 'major' }),
      finding({ productId: 'p3', status: 'verified' }),
    ]
    expect(composeBrief({ ...base, findings }).quietProductIds).toEqual(['p1', 'p2'])
  })

  it('names quiet products in the order they are tracked, once each', () => {
    const brief = composeBrief({ ...base, trackedProductIds: ['p3', 'p1', 'p3', 'p2'], findings: [finding({ productId: 'p1' })] })
    expect(brief.quietProductIds).toEqual(['p3', 'p2'])
  })

  it('does not name a product that was skipped as quiet: it was not looked at', () => {
    const skipped = [{ productId: 'p2', reason: '预算用完' }]
    const brief = composeBrief({ ...base, findings: [finding({ productId: 'p1' })], skipped })
    expect(brief.quietProductIds).toEqual(['p3'])
    expect(brief.skipped).toEqual(skipped)
  })

  it('does not name products nobody tracks, but still shows their findings', () => {
    const brief = composeBrief({ ...base, trackedProductIds: ['p1'], findings: [finding({ id: 'gone', productId: 'old-product' })] })
    expect(brief.findingIds).toEqual(['gone'])
    expect(brief.quietProductIds).toEqual(['p1'])
  })

  it('has no quiet products when everyone had news', () => {
    const findings = [finding({ productId: 'p1' }), finding({ productId: 'p2' }), finding({ productId: 'p3', importance: 'minor' })]
    expect(composeBrief({ ...base, findings }).quietProductIds).toEqual([])
  })

  it('carries the date, the skipped list and the cost', () => {
    const skipped = [{ productId: 'p3', reason: '因预算未跑' }]
    const brief = composeBrief({ ...base, date: '2026-11-25', skipped, costYuan: 3.2, findings: [finding()] })
    expect(brief.date).toBe('2026-11-25')
    expect(brief.skipped).toEqual(skipped)
    expect(brief.costYuan).toBe(3.2)
  })

  it('stamps a new brief with the time it was made', () => {
    const brief = composeBrief({ ...base, findings: [finding()] })
    expect(brief.createdAt).toBe(now.toISOString())
    expect(brief.updatedAt).toBe(now.toISOString())
  })

  it('keeps the original creation time when it replaces an earlier brief of the same day', () => {
    const previous: Brief = { date: '2026-11-25', gist: '旧的', findingIds: ['old'], minorIds: [], quietProductIds: [], skipped: [], costYuan: 0.5, createdAt: stamp(8, 0), updatedAt: stamp(8, 5) }
    const later = at(2026, 11, 25, 14, 0)
    const brief = composeBrief({ ...base, previous, now: later, findings: [finding({ id: 'new' })] })
    expect(brief.createdAt).toBe(previous.createdAt)
    expect(brief.updatedAt).toBe(later.toISOString())
    // Everything else comes from this run, nothing is merged from the old brief.
    expect(brief.findingIds).toEqual(['new'])
    expect(brief.gist).toBe('今天有 3 条变化')
    expect(brief.costYuan).toBe(1.5)
  })

  it('does not modify the findings, skipped list or previous brief it is given', () => {
    const findings = [finding({ id: 'b', createdAt: stamp(9) }), finding({ id: 'a', createdAt: stamp(6) })]
    const skipped = [{ productId: 'p3', reason: 'x' }]
    const snapshot = structuredClone({ findings, skipped })
    const brief = composeBrief({ ...base, findings, skipped })
    expect({ findings, skipped }).toEqual(snapshot)
    brief.skipped.push({ productId: 'p9', reason: 'later' })
    expect(skipped).toHaveLength(1)
  })
})

describe('unreadCount', () => {
  const brief = (over: Partial<Brief> = {}): Brief => ({ date: '2026-11-25', gist: 'g', findingIds: [], minorIds: [], quietProductIds: [], skipped: [], costYuan: 0, createdAt: stamp(8), updatedAt: stamp(8), ...over })
  const map = (...fs: Finding[]) => new Map(fs.map((f) => [f.id, f]))

  it('counts the unread findings of the brief', () => {
    const fs = [finding({ id: 'a', read: false }), finding({ id: 'b', read: true }), finding({ id: 'c', read: false })]
    expect(unreadCount(brief({ findingIds: ['a', 'b', 'c'] }), map(...fs))).toBe(2)
  })

  it('is 0 when everything is read, and when the brief has no findings', () => {
    expect(unreadCount(brief({ findingIds: ['a'] }), map(finding({ id: 'a', read: true })))).toBe(0)
    expect(unreadCount(brief({ findingIds: [] }), map(finding({ id: 'a', read: false })))).toBe(0)
  })

  it('counts only findings listed in the brief, not other unread ones in the map', () => {
    const fs = [finding({ id: 'in', read: false }), finding({ id: 'other-day', read: false })]
    expect(unreadCount(brief({ findingIds: ['in'] }), map(...fs))).toBe(1)
  })

  it('leaves the folded minor findings out, they are not what the number on the sidebar counts', () => {
    const fs = [finding({ id: 'big', read: false }), finding({ id: 'small', importance: 'minor', read: false })]
    expect(unreadCount(brief({ findingIds: ['big'], minorIds: ['small'] }), map(...fs))).toBe(1)
  })

  it('skips ids it has no finding for instead of failing', () => {
    expect(unreadCount(brief({ findingIds: ['a', 'missing'] }), map(finding({ id: 'a', read: false })))).toBe(1)
  })

  it('counts an id that is listed twice once', () => {
    expect(unreadCount(brief({ findingIds: ['a', 'a'] }), map(finding({ id: 'a', read: false })))).toBe(1)
  })

  it('goes down as findings get read (the sidebar number)', () => {
    const a = finding({ id: 'a', read: false })
    const b = finding({ id: 'b', read: false })
    const m = map(a, b)
    const br = brief({ findingIds: ['a', 'b'] })
    expect(unreadCount(br, m)).toBe(2)
    m.set('a', { ...a, read: true })
    expect(unreadCount(br, m)).toBe(1)
    m.set('b', { ...b, read: true })
    expect(unreadCount(br, m)).toBe(0)
  })
})
