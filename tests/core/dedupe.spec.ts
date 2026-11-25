import { describe, expect, it } from 'vitest'
import { canonicalUrl, findingKey, isDuplicate } from '../../src/core/dedupe.ts'
import { canonicalUrl as urlCanonicalUrl } from '../../src/core/url.ts'

const wechat = (q: string) => `https://mp.weixin.qq.com/s?${q}`
const recent = (productId: string, headline: string, urls: string[]) => ({ productId, headline, dedupeKey: findingKey(productId, headline, urls), urls })

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

  it('keeps a decimal point, a comma or another mark standing between two digits, since it makes the number', () => {
    expect(findingKey('p', '会员价降至 1.5 元', [])).not.toBe(findingKey('p', '会员价降至 15 元', []))
    expect(findingKey('p', 'GPT-4.5', [])).not.toBe(findingKey('p', 'GPT-45', []))
    expect(findingKey('p', '月费 3-5 元', [])).not.toBe(findingKey('p', '月费 35 元', []))
    expect(findingKey('p', '10:30 开售', [])).not.toBe(findingKey('p', '1030 开售', []))
    expect(findingKey('p', '版本 1.5.2', [])).not.toBe(findingKey('p', '版本 152', []))
    expect(findingKey('p', '1,000 万用户', [])).not.toBe(findingKey('p', '1000 万用户', []))
    // Full-width forms are folded first, so they count as the same mark.
    expect(findingKey('p', '会员价降至 1．5 元', [])).toBe(findingKey('p', '会员价降至 1.5 元', []))
    expect(findingKey('p', '用户 1，000 万', [])).toBe(findingKey('p', '用户 1,000 万', []))
  })

  it('still drops the same marks where they do not stand between two digits', () => {
    expect(findingKey('p', 'GPT-4.5 发布', [])).toBe(findingKey('p', 'GPT-4.5发布！', []))
    expect(findingKey('p', '涨到 1.5。', [])).toBe(findingKey('p', '涨到 1.5', []))
    expect(findingKey('p', 'V2. 发布', [])).toBe(findingKey('p', 'V2 发布', []))
    expect(findingKey('p', '价格 .5 元', [])).toBe(findingKey('p', '价格 5 元', []))
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
    expect(isDuplicate({ productId: 'p', headline: '完全不同的标题', urls: ['https://www.a.com/x/?utm_source=x'] }, [{ productId: 'p', headline: '另一个标题', dedupeKey: 'k', urls: ['https://a.com/x'] }])).toBe(true))

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
    expect(isDuplicate({ productId: 'p', headline: 'A', urls: [''] }, [{ productId: 'p', headline: 'B', dedupeKey: 'k', urls: ['', '  '] }])).toBe(false)
  })

  it('is not a duplicate when the headline and URLs both differ', () =>
    expect(isDuplicate({ productId: 'p', headline: '新功能上线', urls: ['https://a.com/x'] }, [recent('p', '价格调整', ['https://a.com/y'])])).toBe(false))

  it('never matches across products, even with the same URL and headline', () => {
    const urls = ['https://a.com/x']
    expect(isDuplicate({ productId: 'p', headline: '同一条', urls }, [recent('q', '同一条', urls)])).toBe(false)
  })

  it('is not a duplicate when there is nothing to compare with', () =>
    expect(isDuplicate({ productId: 'p', headline: '标题', urls: ['https://a.com/x'] }, [])).toBe(false))

  it('treats the same headline as the same finding even when the articles are entirely different', () => {
    // The same news found again through another repost, or resubmitted the next day with new links.
    const rec = [recent('p', 'DeepSeek 发布 V4，价格下调', ['https://a.com/x', 'https://b.com/y'])]
    expect(isDuplicate({ productId: 'p', headline: 'DeepSeek 发布 V4，价格下调', urls: ['https://c.com/z'] }, rec)).toBe(true)
    expect(isDuplicate({ productId: 'p', headline: 'DeepSeek 发布 V4，价格下调', urls: [] }, rec)).toBe(true)
    expect(isDuplicate({ productId: 'p', headline: 'DeepSeek 发布 V4，价格下调', urls: ['https://d.com/1', 'https://e.com/2'] }, [recent('p', 'DeepSeek 发布 V4，价格下调', [])])).toBe(true)
  })

  it('treats headlines that differ only in punctuation, whitespace, width or case as the same', () => {
    const rec = [recent('p', 'DeepSeek 发布 V4：价格下调！', ['https://a.com/x'])]
    for (const headline of ['deepseek发布v4 价格下调', 'DEEPSEEK　发布「V4」，价格下调。', 'ＤｅｅｐＳｅｅｋ发布Ｖ４价格下调', '  DeepSeek发布V4 —— 价格下调  ']) {
      expect(isDuplicate({ productId: 'p', headline, urls: ['https://other.com/news'] }, rec), headline).toBe(true)
    }
  })

  it('does not match a headline of another product, even when the text and the articles are the same', () => {
    const rec = [recent('q', '同一条新闻', ['https://a.com/x'])]
    expect(isDuplicate({ productId: 'p', headline: '同一条新闻', urls: ['https://c.com/z'] }, rec)).toBe(false)
    expect(isDuplicate({ productId: 'p', headline: '同一条新闻', urls: ['https://a.com/x'] }, rec)).toBe(false)
  })

  it('does not merge two different numbers: 1.5 is not 15, GPT-4.5 is not GPT-45', () => {
    const price = [recent('p', '会员价降至 15 元', ['https://a.com/x'])]
    expect(isDuplicate({ productId: 'p', headline: '会员价降至 1.5 元', urls: ['https://c.com/z'] }, price)).toBe(false)
    const model = [recent('p', 'GPT-45', ['https://a.com/x'])]
    expect(isDuplicate({ productId: 'p', headline: 'GPT-4.5', urls: ['https://c.com/z'] }, model)).toBe(false)
    expect(isDuplicate({ productId: 'p', headline: '月费 3-5 元', urls: ['https://c.com/z'] }, [recent('p', '月费 35 元', [])])).toBe(false)
    expect(isDuplicate({ productId: 'p', headline: '10:30 开售', urls: ['https://c.com/z'] }, [recent('p', '1030 开售', [])])).toBe(false)
  })

  it('still sees the same number written with different marks around it as the same headline', () => {
    const rec = [recent('p', 'GPT-4.5 发布', ['https://a.com/x'])]
    expect(isDuplicate({ productId: 'p', headline: 'GPT-4.5发布！', urls: ['https://c.com/z'] }, rec)).toBe(true)
    expect(isDuplicate({ productId: 'p', headline: 'ＧＰＴ－４．５　发布', urls: ['https://c.com/z'] }, rec)).toBe(true)
    expect(isDuplicate({ productId: 'p', headline: '会员价降至 1．5 元！', urls: ['https://c.com/z'] }, [recent('p', '会员价降至 1.5 元', [])])).toBe(true)
  })

  it('does not treat 1,000 and 1000 as the same headline (a missed merge shows a story twice, a wrong one hides it)', () => {
    expect(isDuplicate({ productId: 'p', headline: '1,000 万用户', urls: ['https://c.com/z'] }, [recent('p', '1000 万用户', [])])).toBe(false)
    expect(isDuplicate({ productId: 'p', headline: '1,000 万用户', urls: ['https://c.com/z'] }, [recent('p', '1,000 万用户！', [])])).toBe(true)
  })

  it('does not match a different headline over different articles', () => {
    const rec = [recent('p', 'DeepSeek 发布 V4', ['https://a.com/x'])]
    expect(isDuplicate({ productId: 'p', headline: 'DeepSeek 发布 V4.1', urls: ['https://c.com/z'] }, rec)).toBe(false)
    expect(isDuplicate({ productId: 'p', headline: 'DeepSeek 下调价格', urls: ['https://c.com/z'] }, rec)).toBe(false)
  })

  it('does not match two headlines that are nothing but punctuation just because both are empty once stripped', () => {
    const rec = [recent('p', '……！！', ['https://a.com/x'])]
    expect(isDuplicate({ productId: 'p', headline: '？？', urls: ['https://c.com/z'] }, rec)).toBe(false)
    expect(isDuplicate({ productId: 'p', headline: '   ', urls: [] }, rec)).toBe(false)
  })

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
