import { describe, expect, it } from 'vitest'
import { say } from '../../src/core/messages.ts'
import { counted, labelOf, told } from '../../src/client/words.ts'
import { joinAdded } from '../../src/client/pages/product/richText.tsx'
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

describe('counting in English', () => {
  it('says one thing in the singular, and two in the plural; Chinese has one form', () => {
    expect(counted(tEn, 'dossier.sourceCount', { count: 1 })).toBe('1 source')
    expect(counted(tEn, 'dossier.sourceCount', { count: 2 })).toBe('2 sources')
    expect(counted(tEn, 'runs.meta', { count: 1 })).toBe('Last 7 days · 1 run · costs are estimates')
    expect(counted(t, 'dossier.sourceCount', { count: 1 })).toBe('1 个来源')
    expect(told(tEn, say('retried', { reason: say('sessionError'), count: 1 }))).toBe('The session ran into an error (tried again 1 time)')
  })
})

describe('what an update added', () => {
  it('reads as one stretch across gaps of a few characters or of punctuation and citations', () => {
    const text = '小豆开放了记忆导出，用户可以一键带走全部偏好。[1]另有说明。'
    expect(joinAdded(text, [{ start: 2, end: 4 }, { start: 5, end: 9 }, { start: 10, end: 12 }])).toEqual([{ start: 2, end: 12 }])
    expect(joinAdded(text, [{ start: 14, end: 22 }, { start: 23, end: 26 }])).toEqual([{ start: 14, end: 26 }]) // 。[1] between
    expect(joinAdded(text, [{ start: 0, end: 2 }, { start: 14, end: 16 }])).toEqual([{ start: 0, end: 2 }, { start: 14, end: 16 }]) // words between: two
  })
})

