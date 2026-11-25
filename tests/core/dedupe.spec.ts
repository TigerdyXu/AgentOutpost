import { describe, expect, it } from 'vitest'
import { canonicalUrl, findingKey, isDuplicate } from '../../src/core/dedupe.ts'
import { canonicalUrl as urlCanonicalUrl } from '../../src/core/url.ts'

const wechat = (q: string) => `https://mp.weixin.qq.com/s?${q}`
const recent = (productId: string, headline: string, urls: string[]) => ({ productId, dedupeKey: findingKey(productId, headline, urls), urls })

describe('canonicalUrl', () => {
  it('is the one from url.ts, which keeps the query (no second definition that drops it)', () => {
    expect(canonicalUrl).toBe(urlCanonicalUrl)
    expect(canonicalUrl('https://mp.weixin.qq.com/s?__biz=A&mid=1&idx=1&sn=a')).not.toBe(canonicalUrl('https://mp.weixin.qq.com/s?__biz=B&mid=2&idx=1&sn=b'))
  })
})

describe('findingKey', () => {
  it('ignores whitespace, punctuation, full-width forms and case in the headline', () => {
    const a = findingKey('p', 'DeepSeek 发布 V4：价格下调！', [])
    expect(findingKey('p', 'deepseek发布v4 价格下调', [])).toBe(a)
    expect(findingKey('p', 'ＤｅｅｐＳｅｅｋ　发布「Ｖ４」，价格下调。', [])).toBe(a)
  })

  it('keeps headlines that really differ apart, including the characters that carry meaning', () => {
    expect(findingKey('p', '价格降 50%', [])).not.toBe(findingKey('p', '价格降 60%', []))
    expect(findingKey('p', '推出新功能 A', [])).not.toBe(findingKey('p', '推出新功能 B', []))
  })

  it('does not depend on URL order, URL tracking, repeated URLs or the www prefix', () => {
    const a = findingKey('p', '标题', ['https://b.com/y', 'https://www.a.com/x/?utm_source=t'])
    expect(findingKey('p', '标题', ['http://a.com/x', 'https://b.com/y/'])).toBe(a)
    expect(findingKey('p', '标题', ['https://b.com/y', 'https://a.com/x', 'https://a.com/x?utm_medium=z'])).toBe(a)
  })

  it('differs by product, by URL set and by headline', () => {
    const base = findingKey('p', '标题', ['https://a.com/x'])
    expect(findingKey('q', '标题', ['https://a.com/x'])).not.toBe(base)
    expect(findingKey('p', '标题', ['https://a.com/y'])).not.toBe(base)
    expect(findingKey('p', '另一个标题', ['https://a.com/x'])).not.toBe(base)
    expect(findingKey('p', '标题', ['https://a.com/x', 'https://a.com/y'])).not.toBe(base)
  })

  it('tells two WeChat articles apart (the query is the page)', () => {
    expect(findingKey('p', '标题', [wechat('__biz=A&mid=1&idx=1&sn=a')])).not.toBe(findingKey('p', '标题', [wechat('__biz=B&mid=2&idx=1&sn=b')]))
  })
})

describe('isDuplicate', () => {
  it('treats a shared article URL as the same finding', () =>
    expect(isDuplicate({ productId: 'p', headline: '完全不同的标题', urls: ['https://www.a.com/x/?utm_source=x'] }, [{ productId: 'p', dedupeKey: 'k', urls: ['https://a.com/x'] }])).toBe(true))

  it('shares a URL if any one of several matches', () =>
    expect(isDuplicate({ productId: 'p', headline: '新标题', urls: ['https://c.com/z', 'https://a.com/x#top'] }, [recent('p', '旧标题', ['https://b.com/y', 'http://www.a.com/x/'])])).toBe(true))

  it('treats the same headline and the same URLs as the same finding, however they are written', () => {
    const rec = [recent('p', 'DeepSeek 发布 V4', ['https://a.com/x', 'https://b.com/y'])]
    expect(isDuplicate({ productId: 'p', headline: 'deepseek发布V4！', urls: ['https://b.com/y', 'https://www.a.com/x?utm_source=s'] }, rec)).toBe(true)
  })

  it('matches by key alone when a finding has no URLs at all', () => {
    const rec = [recent('p', '官方宣布停服', [])]
    expect(isDuplicate({ productId: 'p', headline: '官方宣布停服。', urls: [] }, rec)).toBe(true)
    expect(isDuplicate({ productId: 'p', headline: '官方宣布涨价', urls: [] }, rec)).toBe(false)
  })

  it('does not count two findings with no URLs as sharing an (empty) URL', () => {
    expect(isDuplicate({ productId: 'p', headline: 'A', urls: [''] }, [{ productId: 'p', dedupeKey: 'k', urls: ['', '  '] }])).toBe(false)
  })

  it('is not a duplicate when the headline and URLs both differ', () =>
    expect(isDuplicate({ productId: 'p', headline: '新功能上线', urls: ['https://a.com/x'] }, [recent('p', '价格调整', ['https://a.com/y'])])).toBe(false))

  it('never matches across products, even with the same URL and headline', () => {
    const urls = ['https://a.com/x']
    expect(isDuplicate({ productId: 'p', headline: '同一条', urls }, [recent('q', '同一条', urls)])).toBe(false)
  })

  it('is not a duplicate when there is nothing to compare with', () =>
    expect(isDuplicate({ productId: 'p', headline: '标题', urls: ['https://a.com/x'] }, [])).toBe(false))

  it('keeps two different WeChat articles of the same product as two findings', () => {
    const first = wechat('__biz=A&mid=1&idx=1&sn=a')
    const second = wechat('__biz=B&mid=2&idx=1&sn=b')
    expect(isDuplicate({ productId: 'p', headline: '第二篇文章', urls: [second] }, [recent('p', '第一篇文章', [first])])).toBe(false)
  })

  it('still sees the same WeChat article behind its share tracking and a fragment', () => {
    const plain = wechat('__biz=A&mid=1&idx=1&sn=a')
    const shared = wechat('__biz=A&mid=1&idx=1&sn=a&scene=21&chksm=ee12') + '#wechat_redirect'
    expect(isDuplicate({ productId: 'p', headline: '换了个标题再提交', urls: [shared] }, [recent('p', '第一篇文章', [plain])])).toBe(true)
  })

  it('matches against any one of several recent findings', () => {
    const rec = [recent('p', '甲', ['https://a.com/1']), recent('q', '乙', ['https://a.com/2']), recent('p', '丙', ['https://a.com/3'])]
    expect(isDuplicate({ productId: 'p', headline: '丁', urls: ['https://a.com/3'] }, rec)).toBe(true)
    expect(isDuplicate({ productId: 'p', headline: '丁', urls: ['https://a.com/2'] }, rec)).toBe(false)
  })
})
