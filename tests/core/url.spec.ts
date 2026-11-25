import { expect, it } from 'vitest'
import { canonicalUrl } from '../../src/core/url.ts'

const wechat = (q: string) => `https://mp.weixin.qq.com/s?${q}`

it('keeps the query so two WeChat articles stay two pages', () => {
  const a = canonicalUrl(wechat('__biz=MzA1&mid=2650&idx=1&sn=aaa111'))
  const b = canonicalUrl(wechat('__biz=MzB9&mid=2711&idx=1&sn=bbb222'))
  expect(a).not.toBe(b)
  // Same account, another article of the day: only mid/sn differ.
  expect(canonicalUrl(wechat('__biz=MzA1&mid=2650&idx=1&sn=aaa111'))).not.toBe(canonicalUrl(wechat('__biz=MzA1&mid=2651&idx=2&sn=ccc333')))
  expect(a).toBe('mp.weixin.qq.com/s?__biz=MzA1&idx=1&mid=2650&sn=aaa111')
})

it('gives the same WeChat article one address with or without its share tracking', () => {
  const plain = wechat('__biz=MzA1&mid=2650&idx=1&sn=aaa111')
  const shared = wechat('__biz=MzA1&mid=2650&idx=1&sn=aaa111&chksm=ee12&scene=21') + '#wechat_redirect'
  expect(canonicalUrl(shared)).toBe(canonicalUrl(plain))
  // Parameter order does not matter either.
  expect(canonicalUrl(wechat('sn=aaa111&idx=1&mid=2650&__biz=MzA1'))).toBe(canonicalUrl(plain))
})

it('drops the scheme, www, case of the host, trailing slash and fragment, and sorts the query', () => {
  expect(canonicalUrl('https://www.A.com/x/?utm_source=t&b=2&a=1')).toBe('a.com/x?a=1&b=2')
  expect(canonicalUrl('http://a.com/x#top')).toBe('a.com/x')
  expect(canonicalUrl('https://A.com/')).toBe('a.com')
  expect(canonicalUrl('https://a.com/x///')).toBe('a.com/x')
  // The path is case sensitive, the host is not.
  expect(canonicalUrl('https://a.com/X')).not.toBe(canonicalUrl('https://a.com/x'))
  expect(canonicalUrl('https://example.com:8080/x')).toBe('example.com:8080/x')
})

it('removes every kind of tracking parameter but keeps the ones that name the page', () => {
  const tracked = 'https://a.com/p?id=7&utm_medium=m&UTM_Campaign=c&spm=a.b&from=feed&scene=1&share_token=z&shareId=9&isappinstalled=0&ref=x&src=y&clicktime=1&enterid=2&sessionid=3&chksm=4'
  expect(canonicalUrl(tracked)).toBe('a.com/p?id=7')
  // Only whole names and prefixes match: "format" and "source" are not tracking.
  expect(canonicalUrl('https://a.com/p?format=pdf&source=news')).toBe('a.com/p?format=pdf&source=news')
  expect(canonicalUrl('https://a.com/p?utm_source=x')).toBe('a.com/p')
})

it('falls back to the trimmed lower-cased text when the address cannot be parsed', () => {
  expect(canonicalUrl('  Not A URL  ')).toBe('not a url')
})
