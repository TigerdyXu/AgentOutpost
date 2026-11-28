import { describe, expect, it } from 'vitest'
import { heard, SAID, say, type SaidKey } from '../../src/core/messages.ts'

const KEYS = Object.keys(SAID) as SaidKey[]
const names = (template: string) => [...template.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()

describe('the host’s fixed sentences', () => {
  it('give each sentence the same parameters in Chinese and English', () => {
    for (const key of KEYS) expect(names(SAID[key][1]), key).toEqual(names(SAID[key][0]))
  })

  it('fill the parameters of the Chinese sentence', () => {
    expect(say('timeout', { minutes: 30 })).toBe('超过 30 分钟没有结束，已停止')
    expect(say('stopped')).toBe('前哨已停止')
    expect(say('checkNotDone', { reason: '' })).toBe('核查没有完成：')
  })

  it('recognise every sentence they write, with its parameters', () => {
    for (const key of KEYS) {
      const params = Object.fromEntries(names(SAID[key][0]).map(name => [name, name === 'count' || name === 'minutes' || name === 'max' ? '3' : `«${name}»`]))
      expect(heard(say(key, params)), key).toEqual({ key, params })
    }
  })

  it('recognise a sentence inside another one, the reason first', () => {
    expect(heard('核查没有完成：前哨已停止')).toEqual({ key: 'checkNotDone', params: { reason: '前哨已停止' } })
    const outer = heard('fetch failed（已重试 3 次）')
    expect(outer).toEqual({ key: 'retried', params: { reason: 'fetch failed', count: '3' } })
  })

  it('do not recognise a text that is none of them', () => {
    expect(heard('429 Too Many Requests')).toBeNull()
    expect(heard('前哨已停止了')).toBeNull()
    expect(heard('')).toBeNull()
  })
})
