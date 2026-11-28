import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { packageRoot, renderPrompt } from '../../src/host/prompts.ts'

const RECOMMEND_VARS = { trackName: 'AI 编程助手', trackBrief: '盯住编程 Agent', dimensions: '定位、体验', today: '2026-11-25', tracked: '（还没有）', elsewhere: '千问Go!（阿里巴巴）', previous: '（没有）', refine: '{{trackName}} 原样保留', passedOver: '（没有）' }
const BASELINE_VARS = { productName: 'Cursor', company: 'Anysphere', form: 'IDE', officialDomains: 'cursor.com', today: '2026-11-25', dimensions: '- positioning：定位' }
const VERIFY_VARS = { productName: 'Cursor', company: 'Anysphere', officialDomains: 'cursor.com', today: '2026-11-25' }
const DAILY_VARS = { productName: 'Cursor', company: 'Anysphere', form: 'IDE', officialDomains: 'cursor.com', today: '2026-11-25', lastRun: '2026-11-24' }
const IDENTIFY_VARS = { trackName: '个人 Agent', trackBrief: '能替人办事的 Agent', today: '2026-11-26', name: 'Gemini Agent', officialUrl: 'https://gemini.google/agent/', elsewhere: '千问Go!（阿里巴巴）、小豆（字节跳动）' }
/** Characters of the prompt text itself, without whitespace and the filled-in values. */
const ownLength = (name: 'recommend' | 'baseline' | 'verify' | 'daily' | 'identify') => readFileSync(join(packageRoot(), 'prompts', `${name}.md`), 'utf8').replace(/\{\{\w+\}\}/g, '').replace(/\s/g, '').length

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
    expect(ownLength('recommend')).toBeLessThanOrEqual(1500)
    expect(ownLength('baseline')).toBeLessThanOrEqual(1600)
    expect(ownLength('verify')).toBeLessThanOrEqual(1500)
    expect(ownLength('daily')).toBeLessThanOrEqual(1500)
    expect(ownLength('identify')).toBeLessThanOrEqual(800)
  })

  it('tells the confirming agent to check only the product typed, and when to turn it down', () => {
    const identify = renderPrompt('identify', IDENTIFY_VARS)
    for (const said of ['个人 Agent', '能替人办事的 Agent', '2026-11-26', 'Gemini Agent', 'https://gemini.google/agent/',
      'outpost_submit_candidate', 'outpost_done', '只核实这一个', 'strong', 'consider', 'excluded', 'reason', '停', '不属于这个赛道', '不要编'])
      expect(identify, said).toContain(said)
    // The products already followed, with the rule to copy their spelling, on one line: a product named a little
    // differently must not become a second one.
    expect(identify).toMatch(/千问Go!（阿里巴巴）、小豆（字节跳动）[^\n]*name 和 company 照抄/)
    expect(identify).not.toContain('可纠正用户的写法')
    expect(identify).not.toMatch(/\{\{|\}\}/)
  })

  it('tells the agents the rules they are held to', () => {
    const recommend = renderPrompt('recommend', RECOMMEND_VARS)
    for (const rule of ['outpost_submit_candidate', 'outpost_done', '4–8', '最多 6 个', 'excluded', '不要编', 'articles', 'tier', 'strong', 'consider', '每个候选至少 1 篇报道', '找不到就不要提交', '别的赛道已在跟踪的产品：千问Go!（阿里巴巴）', '照抄这里的写法'])
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
      // M1.6: who published the page is the checker's call, by the page, not by the recorded domain.
      'official：Anysphere 自己发的页面', '官方账号', '论坛帖', '同名', '看不出填 null', '可能记错，以页面为准', '来源的 official 为 true',
    ]) expect(verify, rule).toContain(rule)
    // 待确认 findings: only what was not seen yet is opened again, then the search for a second source.
    expect(verify).toMatch(/unconfirmedFindings：[^\n]*needsCheck 为 true[^\n]*不要再打开[^\n]*第 4 步/)
  })

  it('tells the daily analyst to read first, report only what is new, and stop when there is nothing', () => {
    const daily = renderPrompt('daily', DAILY_VARS)
    for (const rule of [
      'outpost_read', 'outpost_submit_finding', 'outpost_propose_card_edit', "outpost_done('无新动态')", 'recentFindings', 'knownUrls', '2026-11-24',
      '发版', '更新日志', '官方公告', '报道', '用户口碑', 'self', 'third-party', 'major', 'notable', 'minor', 'findingIds', '逐字', '不要凑数',
      '在 outpost_read 给的 body 上改', 'dimensions',
    ]) expect(daily, rule).toContain(rule)
    expect(daily.indexOf('outpost_read')).toBeLessThan(daily.indexOf('outpost_submit_finding'))
    expect(daily).not.toContain('outpost_submit_facts') // the daily run has no such tool
    // The dimensions a finding touches are asked for in the step that describes the finding.
    const step4 = daily.slice(daily.indexOf('4. '), daily.indexOf('5. '))
    expect(step4).toMatch(/dimensions[^\n]*outpost_read/)
  })

  it('tells the daily analyst to open a blocked page with the browser, at most 3 pages a run, and to move on without one', () => {
    const daily = renderPrompt('daily', DAILY_VARS)
    expect(daily).toMatch(/## 工具[^#]*browser[^\n]*浏览器工具/)
    const step2 = daily.slice(daily.indexOf('2. '), daily.indexOf('3. '))
    for (const said of ['web_fetch', '验证页', '登录页', '公众号', '知乎', '小红书', '浏览器打开', '最多 3 个网页', '换别的来源'])
      expect(step2, said).toContain(said)
  })

  it('tells the profile and recommend agents the same: a blocked page goes to the browser, at most 3 pages', () => {
    for (const text of [renderPrompt('baseline', BASELINE_VARS), renderPrompt('recommend', RECOMMEND_VARS)]) {
      const step2 = text.slice(text.indexOf('2. '), text.indexOf('3. '))
      for (const said of ['验证页', '登录页', 'browser', '浏览器', '最多 3 个网页']) expect(step2, said).toContain(said)
      // Only when the session has one: research on the preset without a browser (M1.4) has none.
      expect(step2).toMatch(/有[^，。\n]*browser[^，。\n]*浏览器工具就用/)
    }
  })

  it('tells the daily analyst that pages updated in place stay sources of new entries, and to skip only news already reported', () => {
    const daily = renderPrompt('daily', DAILY_VARS)
    const step1 = daily.slice(daily.indexOf('1. '), daily.indexOf('2. '))
    for (const page of ['更新日志', '发布说明', 'App Store', '官方博客']) expect(step1, page).toContain(page)
    expect(step1).toMatch(/knownUrls[^\n]*新条目[^\n]*recentFindings/)
    expect(daily).not.toContain('knownUrls 里的网址不算新来源')
  })
})
