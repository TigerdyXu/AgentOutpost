import { describe, expect, it } from 'vitest'
import { judge, type Evidence } from '../../src/core/credibility.ts'

const d0 = new Date('2026-11-25T08:00:00.000Z')
const plusDays = (d: Date, n: number) => new Date(d.getTime() + n * 24 * 60 * 60 * 1000)
const ev = (over: Partial<Evidence> = {}): Evidence => ({
  url: 'https://a.com/x', isOfficial: false, syndicationGroup: null, openedVia: 'http', quoteFound: null, supportsClaim: null, ...over,
})
const NOT_FOUND = '引句在原文中找不到或不支持结论'

describe('judge', () => {
  it('verifies a self claim backed by one confirmed official source', () => {
    const v = judge({ claimKind: 'self', evidence: [ev({ isOfficial: true, openedVia: 'http', quoteFound: true })], firstSeen: d0, now: d0 })
    expect(v).toEqual({ status: 'verified', note: null, unconfirmedUntil: null })
  })

  it('keeps a third-party claim with one source unconfirmed for 7 days', () => {
    const v = judge({ claimKind: 'third-party', evidence: [ev({ openedVia: 'http', quoteFound: true })], firstSeen: d0, now: d0 })
    expect(v).toEqual({ status: 'unconfirmed', note: '只有一个来源', unconfirmedUntil: plusDays(d0, 7).toISOString() })
  })

  it('counts reposts of one press release once', () => {
    const v = judge({
      claimKind: 'third-party',
      evidence: [
        ev({ syndicationGroup: 'pr-1', quoteFound: true, openedVia: 'http' }),
        ev({ syndicationGroup: 'pr-1', quoteFound: true, openedVia: 'http', url: 'https://b.com/x' }),
      ],
      firstSeen: d0,
      now: d0,
    })
    expect(v.status).toBe('unconfirmed')
    expect(v.note).toBe('只有一个来源')
  })

  it('counts the same page seen twice once, whatever the www, trailing slash, tracking query, fragment or case', () => {
    const v = judge({
      claimKind: 'third-party',
      evidence: [
        ev({ url: 'https://news.example.com/a/b', quoteFound: true }),
        ev({ url: 'https://WWW.news.example.com/a/b/?utm_source=x#top', quoteFound: true }),
      ],
      firstSeen: d0,
      now: d0,
    })
    expect(v.status).toBe('unconfirmed')
  })

  it('verifies a third-party claim with two independent sources', () => {
    const v = judge({
      claimKind: 'third-party',
      evidence: [
        ev({ url: 'https://a.com/x', quoteFound: true }),
        ev({ url: 'https://b.com/y', quoteFound: true, openedVia: 'browser' }),
      ],
      firstSeen: d0,
      now: d0,
    })
    expect(v).toEqual({ status: 'verified', note: null, unconfirmedUntil: null })
    // Two different press releases are two sources, a repost of either adds nothing.
    const mixed = judge({
      claimKind: 'third-party',
      evidence: [
        ev({ url: 'https://a.com/x', syndicationGroup: 'pr-1', quoteFound: true }),
        ev({ url: 'https://b.com/x', syndicationGroup: 'pr-1', quoteFound: true }),
        ev({ url: 'https://c.com/z', syndicationGroup: 'pr-2', quoteFound: true }),
      ],
      firstSeen: d0,
      now: d0,
    })
    expect(mixed.status).toBe('verified')
  })

  it('accepts a search-snippet match as a confirmed source', () => {
    const snippet = ev({ openedVia: 'snippet', quoteFound: true })
    expect(judge({ claimKind: 'self', evidence: [{ ...snippet, isOfficial: true }], firstSeen: d0, now: d0 }).status).toBe('verified')
    const two = judge({
      claimKind: 'third-party',
      evidence: [snippet, ev({ url: 'https://b.com/y', openedVia: 'snippet', quoteFound: true })],
      firstSeen: d0,
      now: d0,
    })
    expect(two.status).toBe('verified')
  })

  it('marks an unopenable source 原文打不开 instead of withdrawing', () => {
    const v = judge({ claimKind: 'self', evidence: [ev({ isOfficial: true, openedVia: 'unopened', quoteFound: null })], firstSeen: d0, now: d0 })
    expect(v.status).toBe('unconfirmed')
    expect(v.note).toBe('原文打不开')
    expect(v.unconfirmedUntil).toBe(plusDays(d0, 7).toISOString())
  })

  it('withdraws when every opened source lacks the quote', () => {
    const v = judge({
      claimKind: 'third-party',
      evidence: [
        ev({ openedVia: 'http', quoteFound: false }),
        // The quote is on the page but the page does not say what the finding claims.
        ev({ url: 'https://b.com/y', openedVia: 'browser', quoteFound: true, supportsClaim: false }),
      ],
      firstSeen: d0,
      now: d0,
    })
    expect(v).toEqual({ status: 'withdrawn', note: NOT_FOUND, unconfirmedUntil: null })
  })

  it('does not let a voided source sink the sources that held up', () => {
    const official = ev({ url: 'https://official.com/blog', isOfficial: true, quoteFound: true })
    const fake = ev({ url: 'https://b.com/y', quoteFound: false })
    expect(judge({ claimKind: 'self', evidence: [fake, official], firstSeen: d0, now: d0 }).status).toBe('verified')
    // A voided source is not an unopenable one: the remaining single source decides the note.
    const lone = judge({ claimKind: 'third-party', evidence: [fake, ev({ quoteFound: true })], firstSeen: d0, now: d0 })
    expect(lone.status).toBe('unconfirmed')
    expect(lone.note).toBe('只有一个来源')
    // Voided plus unopenable: nothing was disproved, so not withdrawn.
    const unopened = judge({ claimKind: 'self', evidence: [fake, ev({ url: 'https://mp.weixin.qq.com/s/abc', isOfficial: true, openedVia: 'unopened' })], firstSeen: d0, now: d0 })
    expect(unopened.status).toBe('unconfirmed')
    expect(unopened.note).toBe('原文打不开')
  })

  it('does not void a source that was never opened: a snippet that missed the quote is 原文打不开, not withdrawn', () => {
    // Only a page that was really opened (http or browser) can disprove a finding; a search snippet is a fragment.
    for (const quoteFound of [false, null]) {
      const v = judge({ claimKind: 'self', evidence: [ev({ isOfficial: true, openedVia: 'snippet', quoteFound })], firstSeen: d0, now: d0 })
      expect(v).toEqual({ status: 'unconfirmed', note: '原文打不开', unconfirmedUntil: plusDays(d0, 7).toISOString() })
    }
    // After the 7 days it ages out like any other, keeping the reason.
    const late = judge({ claimKind: 'self', evidence: [ev({ isOfficial: true, openedVia: 'snippet', quoteFound: false })], firstSeen: d0, now: plusDays(d0, 8) })
    expect(late.status).toBe('unproven')
    expect(late.note).toBe('原文打不开')
    // A snippet that did match stays a confirmed source (see the snippet test above): no note, no wait.
    expect(judge({ claimKind: 'self', evidence: [ev({ isOfficial: true, openedVia: 'snippet', quoteFound: true })], firstSeen: d0, now: d0 }).status).toBe('verified')
  })

  it('treats two confirmed WeChat articles from different accounts as two sources', () => {
    const v = judge({
      claimKind: 'third-party',
      evidence: [
        ev({ url: 'https://mp.weixin.qq.com/s?__biz=MzA1&mid=2650&idx=1&sn=aaa111&chksm=ee12&scene=21#wechat_redirect', openedVia: 'browser', quoteFound: true }),
        ev({ url: 'https://mp.weixin.qq.com/s?__biz=MzB9&mid=2711&idx=1&sn=bbb222', openedVia: 'browser', quoteFound: true }),
      ],
      firstSeen: d0,
      now: d0,
    })
    expect(v).toEqual({ status: 'verified', note: null, unconfirmedUntil: null })
    // The same article reached by two share links is still one source.
    const same = judge({
      claimKind: 'third-party',
      evidence: [
        ev({ url: 'https://mp.weixin.qq.com/s?__biz=MzA1&mid=2650&idx=1&sn=aaa111', openedVia: 'browser', quoteFound: true }),
        ev({ url: 'https://mp.weixin.qq.com/s?sn=aaa111&mid=2650&idx=1&__biz=MzA1&chksm=ee12&scene=21#wechat_redirect', openedVia: 'browser', quoteFound: true }),
      ],
      firstSeen: d0,
      now: d0,
    })
    expect(same.status).toBe('unconfirmed')
  })

  it('withdraws a finding that has no source at all', () => {
    expect(judge({ claimKind: 'self', evidence: [], firstSeen: d0, now: d0 }).status).toBe('withdrawn')
  })

  it('turns unconfirmed into unproven after 7 days', () => {
    const evidence = [ev({ openedVia: 'http', quoteFound: true })]
    const input = { claimKind: 'third-party' as const, evidence, firstSeen: d0 }
    // Still inside the window on the seventh day itself.
    expect(judge({ ...input, now: plusDays(d0, 7) }).status).toBe('unconfirmed')
    const late = judge({ ...input, now: new Date(plusDays(d0, 7).getTime() + 1) })
    expect(late.status).toBe('unproven')
    expect(late.note).toBe('只有一个来源')
    expect(late.unconfirmedUntil).toBe(plusDays(d0, 7).toISOString())
    // The unopenable case ages out the same way and keeps its reason.
    const unopened = judge({ claimKind: 'self', evidence: [ev({ isOfficial: true, openedVia: 'unopened' })], firstSeen: d0, now: plusDays(d0, 8) })
    expect(unopened.status).toBe('unproven')
    expect(unopened.note).toBe('原文打不开')
  })

  it('verifies a late finding when a second source shows up inside the window', () => {
    const evidence = [ev({ url: 'https://a.com/x', quoteFound: true }), ev({ url: 'https://b.com/y', quoteFound: true })]
    expect(judge({ claimKind: 'third-party', evidence, firstSeen: d0, now: plusDays(d0, 5) }).status).toBe('verified')
  })

  it('does not take one official source for enough when the claim is someone else\'s', () => {
    const official = ev({ isOfficial: true, quoteFound: true })
    expect(judge({ claimKind: 'third-party', evidence: [official], firstSeen: d0, now: d0 }).status).toBe('unconfirmed')
    // And a self claim needs an *official* source, not just any single one.
    expect(judge({ claimKind: 'self', evidence: [ev({ quoteFound: true })], firstSeen: d0, now: d0 }).status).toBe('unconfirmed')
  })

  it('does not count an official source whose quote was never confirmed', () => {
    const v = judge({ claimKind: 'self', evidence: [ev({ isOfficial: true, openedVia: 'http', quoteFound: null })], firstSeen: d0, now: d0 })
    expect(v.status).toBe('unconfirmed')
  })
})
