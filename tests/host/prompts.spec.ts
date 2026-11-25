import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packageRoot, renderPrompt } from '../../src/host/prompts.ts'

const RECOMMEND_VARS = { trackName: 'AI 编程助手', trackBrief: '盯住编程 Agent', dimensions: '定位、体验', today: '2026-11-25', tracked: '（还没有）', previous: '（没有）', refine: '{{trackName}} 原样保留' }
const BASELINE_VARS = { productName: 'Cursor', company: 'Anysphere', form: 'IDE', officialDomains: 'cursor.com', today: '2026-11-25', dimensions: '- positioning：定位' }
/** Characters of the prompt text itself, without whitespace and the filled-in values. */
const ownLength = (name: 'recommend' | 'baseline') => readFileSync(join(packageRoot(), 'prompts', `${name}.md`), 'utf8').replace(/\{\{\w+\}\}/g, '').replace(/\s/g, '').length

describe('renderPrompt', () => {
  it('finds the package directory from the module', () => {
    expect(JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')).name).toBe('dsh-outpost')
  })

  it('fills in every variable once, without expanding braces inside a value', () => {
    const text = renderPrompt('recommend', RECOMMEND_VARS)
    expect(text).toContain('AI 编程助手')
    expect(text).toContain('{{trackName}} 原样保留')
    expect(text.replace('{{trackName}} 原样保留', '')).not.toMatch(/\{\{|\}\}/)
  })

  it('throws naming the variable that is missing', () => {
    const { refine: _refine, ...rest } = RECOMMEND_VARS
    expect(() => renderPrompt('recommend', rest)).toThrow(/refine/)
    expect(() => renderPrompt('baseline', { ...BASELINE_VARS, dimensions: undefined as unknown as string })).toThrow(/dimensions/)
  })

  it('keeps both research prompts short enough to read in one go', () => {
    expect(ownLength('recommend')).toBeLessThanOrEqual(1600)
    expect(ownLength('baseline')).toBeLessThanOrEqual(1600)
  })

  it('tells the agents the rules they are held to', () => {
    const recommend = renderPrompt('recommend', RECOMMEND_VARS)
    for (const rule of ['outpost_submit_candidate', 'outpost_done', '4–8', '6', 'excluded', '不要编', 'articles']) expect(recommend).toContain(rule)
    const baseline = renderPrompt('baseline', BASELINE_VARS)
    for (const rule of ['outpost_read', 'outpost_submit_card', 'outpost_submit_facts', 'outpost_done', 'inferenceQuotes', 'quote', '逐字', 'isOfficial', '[n]', '1500'])
      expect(baseline).toContain(rule)
  })
})
