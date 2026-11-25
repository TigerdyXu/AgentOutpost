import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packageRoot, renderPrompt } from '../../src/host/prompts.ts'

const RECOMMEND_VARS = { trackName: 'AI 编程助手', trackBrief: '盯住编程 Agent', dimensions: '定位、体验', today: '2026-11-25', tracked: '（还没有）', previous: '（没有）', refine: '{{trackName}} 原样保留' }
const BASELINE_VARS = { productName: 'Cursor', company: 'Anysphere', form: 'IDE', officialDomains: 'cursor.com', today: '2026-11-25', dimensions: '- positioning：定位' }
const VERIFY_VARS = { productName: 'Cursor', company: 'Anysphere', officialDomains: 'cursor.com', today: '2026-11-25' }
const DAILY_VARS = { productName: 'Cursor', company: 'Anysphere', form: 'IDE', officialDomains: 'cursor.com', today: '2026-11-25', lastRun: '2026-11-24' }
/** Characters of the prompt text itself, without whitespace and the filled-in values. */
const ownLength = (name: 'recommend' | 'baseline' | 'verify' | 'daily') => readFileSync(join(packageRoot(), 'prompts', `${name}.md`), 'utf8').replace(/\{\{\w+\}\}/g, '').replace(/\s/g, '').length

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

  it('keeps the research prompts short enough to read in one go', () => {
    expect(ownLength('recommend')).toBeLessThanOrEqual(1600)
    expect(ownLength('baseline')).toBeLessThanOrEqual(1600)
    expect(ownLength('verify')).toBeLessThanOrEqual(1500)
    expect(ownLength('daily')).toBeLessThanOrEqual(1500)
  })

  it('tells the agents the rules they are held to', () => {
    const recommend = renderPrompt('recommend', RECOMMEND_VARS)
    for (const rule of ['outpost_submit_candidate', 'outpost_done', '4–8', '最多 6 个', 'excluded', '不要编', 'articles', 'tier', 'strong', 'consider', '每个候选至少 1 篇报道', '找不到就不要提交'])
      expect(recommend).toContain(rule)
    const baseline = renderPrompt('baseline', BASELINE_VARS)
    for (const rule of ['outpost_read', 'outpost_submit_card', 'outpost_submit_facts', 'outpost_done', 'inferenceQuotes', 'quote', '逐字', 'isOfficial', '[n]', '1500', 'title（≤80 字）', 'publisher（≤30 字）'])
      expect(baseline).toContain(rule)
  })

  it('tells the checker how to open a page, what to report and where to stop', () => {
    const verify = renderPrompt('verify', VERIFY_VARS)
    for (const rule of [
      'outpost_read_pending', 'outpost_report_check', 'outpost_add_source', 'outpost_done', 'web_fetch', 'web_search', '验证页', '登录页', '浏览器工具',
      'snippet', 'unopened', 'http', 'browser', 'syndicationGroup', '原始通稿', '最多搜 3 次', '打开 3 个网页', '不改', '不编造', 'null',
      'needsCheck', '不要再打开', '人机验证', '算没打开', '不要报 http + false',
    ]) expect(verify, rule).toContain(rule)
    // 待确认 findings: only what was not seen yet is opened again, then the search for a second source.
    expect(verify).toMatch(/unconfirmedFindings：[^\n]*needsCheck 为 true[^\n]*不要再打开[^\n]*第 4 步/)
  })

  it('tells the daily analyst to read first, report only what is new, and stop when there is nothing', () => {
    const daily = renderPrompt('daily', DAILY_VARS)
    for (const rule of [
      'outpost_read', 'outpost_submit_finding', 'outpost_propose_card_edit', "outpost_done('无新动态')", 'recentFindings', 'knownUrls', '2026-11-24',
      '发版', '更新日志', '官方公告', '报道', '用户口碑', 'self', 'third-party', 'major', 'notable', 'minor', 'findingIds', '逐字', '不要凑数',
      '在 outpost_read 给的 body 上改',
    ]) expect(daily, rule).toContain(rule)
    expect(daily.indexOf('outpost_read')).toBeLessThan(daily.indexOf('outpost_submit_finding'))
  })
})
