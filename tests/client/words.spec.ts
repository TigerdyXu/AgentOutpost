import { describe, expect, it } from 'vitest'
import { say } from '../../src/core/messages.ts'
import { labelOf, told } from '../../src/client/words.ts'
import { t, tEn } from '../fixtures/client.tsx'

describe('words the panel did not write', () => {
  it('shows a sentence of the host in the reader’s language, and leaves any other text as it is', () => {
    expect(told(tEn, say('timeout', { minutes: 30 }))).toBe('Stopped after running longer than 30 minutes')
    expect(told(t, say('timeout', { minutes: 30 }))).toBe('超过 30 分钟没有结束，已停止')
    expect(told(tEn, say('retried', { reason: say('sessionError'), count: 3 }))).toBe('The session ran into an error (tried again 3 times)')
    expect(told(tEn, 'fetch failed')).toBe('fetch failed')
    expect(told(tEn, say('profiled'))).toBe('Profile built') // a card's first change note (review 5)
    expect(told(tEn, '模型自己写的一句说明')).toBe('模型自己写的一句说明')
  })

  it('names a default dimension in the reader’s language while its name is the default one', () => {
    expect(labelOf(tEn, { key: 'positioning', label: '定位' })).toBe('Positioning')
    expect(labelOf(t, { key: 'positioning', label: '定位' })).toBe('定位')
    // Renamed by the user, or one of their own: as written.
    expect(labelOf(tEn, { key: 'positioning', label: '产品定位' })).toBe('产品定位')
    expect(labelOf(tEn, { key: 'pricing', label: 'Pricing' })).toBe('Pricing')
  })
})
