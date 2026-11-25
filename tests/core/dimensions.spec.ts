import { expect, it } from 'vitest'
import { DEFAULT_DIMENSIONS, slugDimension } from '../../src/core/dimensions.ts'

it('lists the six default dimensions in order', () => {
  expect(DEFAULT_DIMENSIONS).toEqual([
    { key: 'positioning', label: '定位' },
    { key: 'audience', label: '目标人群' },
    { key: 'scenarios', label: '价值场景' },
    { key: 'experience', label: '体验' },
    { key: 'technology', label: '关键技术' },
    { key: 'business', label: '商业化' },
  ])
})

it('slugs a Latin label to lower case with dashes for everything that is not a letter or digit', () => {
  expect(slugDimension('Pricing Model')).toBe('pricing-model')
  expect(slugDimension('  Data & Privacy / 2nd  ')).toBe('data-privacy-2nd')
})

it('names a Chinese label custom- plus the hex codes of its first 8 characters', () => {
  expect(slugDimension('安全')).toBe('custom-5b895168')
  expect(slugDimension('用户增长与留存策略分析')).toBe('custom-75286237589e957f4e0e75595b587b56')
  // Mixed labels and different labels with a shared start stay distinct.
  expect(slugDimension('AI 能力')).not.toBe(slugDimension('AI 体验'))
  expect(slugDimension('AI 能力')).toMatch(/^custom-[0-9a-f]+$/)
})
