// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_DIMENSIONS } from '../../src/core/dimensions.ts'
import type { Candidate, Heat, Product, Run } from '../../src/core/types.ts'
import type { CandidatesView, RunRow } from '../../src/host/api.ts'
import { NewTrack, forgetPicks } from '../../src/client/pages/NewTrack.tsx'
import type { Shell } from '../../src/client/shell/context.ts'
import { all, click, fail, find, mount, product, settle, state, stubApi, submit, text, track, tracked, type, unmount } from '../fixtures/client.tsx'

// ---- a track being picked, and the candidates the recommendation found ----

const TRACK = 't1'
const heat = (extra: Partial<Heat> = {}): Heat => ({ foundCount: 41, datedWeekly: [5, 7, 6, 10, 14], trend: 'up', showBars: true, ...extra })
type Found = CandidatesView['candidates'][number]
/**
 * A candidate of the track's batch `b1`: strong and picked by default unless `extra` says otherwise. Followed elsewhere
 * (`trackedIn` given), its twin is tracking unless `trackedStatus` says otherwise.
 */
const cand = (id: string, name: string, extra: Partial<Candidate> & { product?: Partial<Product>; trackedIn?: string[]; trackedStatus?: Found['trackedStatus'] } = {}): Found => {
  const { product: productExtra, ...rest } = extra
  return {
    id, trackId: TRACK, batchId: 'b1', productId: `p-${id}`, tier: 'strong', oneLiner: `${name}是什么`, reason: `${name}为什么值得看`, heat: heat(), selected: true,
    trackedIn: [], trackedStatus: rest.trackedIn?.length ? 'tracking' : null, ...rest,
    product: product(`p-${id}`, name, { company: '某公司', status: 'candidate', form: 'App', ...productExtra }),
  }
}
const doubao = cand('c1', '豆包·小豆', { product: { company: '字节跳动', form: 'App 内代理' } })
const muse = cand('c2', 'Meta Muse', { product: { company: 'Meta', region: 'overseas', form: '独立 App + 眼镜' } })
const dots = cand('c3', 'OpenAI Dots', { product: { company: 'OpenAI', region: 'overseas' } })
const vivo = cand('c4', '某手机厂商代理', { tier: 'consider', selected: false })
const opensource = cand('c5', '某开源个人代理', { tier: 'consider', selected: false })
const hardware = cand('c6', '某硬件挂件', { tier: 'excluded', selected: false, reason: '是硬件，不在关注范围' })
const FIVE = [doubao, muse, dots, vivo, opensource]

const view = (candidates: Found[], extra: Partial<CandidatesView> = {}): CandidatesView => ({
  batchId: 'b1', running: false, status: 'done', error: null, elapsedSec: 130, candidates, ...extra,
})
const running = (candidates: Found[], extra: Partial<CandidatesView> = {}) => view(candidates, { running: true, status: 'running', elapsedSec: 42, ...extra })

const dimensions = [...DEFAULT_DIMENSIONS, { key: 'memory', label: '记忆' }]
const picking = state({ tracks: [track(TRACK, 'Personal Agent', [], { status: 'picking', brief: '能替人跨 App 办事、有长期记忆的个人代理；国内外都看', dimensions })] })

/** The picking page of `t1` over a stubbed API; `answer` is what the candidates route says (a function for one that changes). */
async function show(answer: CandidatesView | (() => CandidatesView), shell: Partial<Shell> = {}, routes: Record<string, unknown> = {}) {
  const api = stubApi({
    'GET state': picking, 'GET tracks/:id/candidates': typeof answer === 'function' ? answer : () => answer, 'GET runs': { runs: [] },
    'POST tracks/:id/recommend': { batchId: 'b2' }, 'POST tracks/:id/start': { ok: true }, ...routes,
  })
  const context = await mount(<NewTrack />, { state: picking, route: { page: 'newTrack', trackId: TRACK }, ...shell })
  return { api, context }
}

const cards = () => all('.op-pick')
const nameOf = (card: Element) => card.querySelector('.op-pick-name')?.textContent
const names = (scope: ParentNode = document) => [...scope.querySelectorAll('.op-pick')].map(nameOf)
const card = (name: string) => cards().find(c => nameOf(c) === name)!
const box = (name: string) => card(name).querySelector<HTMLInputElement>('input[type="checkbox"]')!
const picked = () => cards().filter(c => c.querySelector<HTMLInputElement>('input')!.checked).map(nameOf)
const group = (title: string) => all('.op-pick-group').find(g => g.querySelector('.op-pick-group-title')?.textContent?.startsWith(title))!
const status = () => document.querySelector('.op-pick-status')?.textContent
const footer = () => document.querySelector('.op-pick-foot')?.textContent
const requestsFor = (api: ReturnType<typeof stubApi>, path: string) => api.requests.filter(r => r.path === path)
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }

beforeEach(() => { forgetPicks() })
afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('step 2: picking products', () => {
  it('shows candidates as they arrive while the recommendation runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let current = running([doubao], { elapsedSec: 12 })
    await show(() => current)
    // The first one is already there, picked; the line says it is still looking, and for how long.
    expect(names()).toEqual(['豆包·小豆'])
    expect(status()).toBe('正在找…已找到 1 个 · 已用 12 秒')
    // More arrive on the next reads, without a reload.
    current = running([doubao, muse, vivo], { elapsedSec: 72 })
    await advance(2000)
    expect(names()).toEqual(['豆包·小豆', 'Meta Muse', '某手机厂商代理'])
    expect(status()).toBe('正在找…已找到 3 个 · 已用 1 分 12 秒')
    // When it is over, the line says how many and how long it took (excluded ones count: they were found).
    current = view([doubao, muse, dots, vivo, opensource, hardware], { elapsedSec: 130 })
    await advance(2000)
    expect(status()).toBe('找到 6 个候选，按热度和贴合度排好 · 用时 2 分 10 秒')
    expect(names()).toHaveLength(5)
  })

  it('pre-selects strong candidates and updates the footer count', async () => {
    const { context } = await show(view(FIVE))
    // Strong ones are picked, the others not; the footer and the middle column say how many.
    expect(picked()).toEqual(['豆包·小豆', 'Meta Muse', 'OpenAI Dots'])
    expect(footer()).toContain('已选 3 个')
    expect(context.setPicks).toHaveBeenLastCalledWith(TRACK, 3)
    expect(find('开始跟踪 3 个')).toBeTruthy()
    // Ticking one on and one off.
    await click(box('某手机厂商代理'))
    await click(box('Meta Muse'))
    expect(picked()).toEqual(['豆包·小豆', 'OpenAI Dots', '某手机厂商代理'])
    expect(footer()).toContain('已选 3 个')
    await click(box('OpenAI Dots'))
    expect(footer()).toContain('已选 2 个')
    expect(context.setPicks).toHaveBeenLastCalledWith(TRACK, 2)
    expect(find('开始跟踪 2 个')).toBeTruthy()
    // 全选这一组 picks every strong one; it does not touch the other group.
    await click('全选这一组')
    expect(picked()).toEqual(['豆包·小豆', 'Meta Muse', 'OpenAI Dots', '某手机厂商代理'])
    expect(context.setPicks).toHaveBeenLastCalledWith(TRACK, 4)
    // With nothing picked there is nothing to start.
    for (const name of ['豆包·小豆', 'Meta Muse', 'OpenAI Dots', '某手机厂商代理']) await click(box(name))
    expect(footer()).toContain('已选 0 个')
    expect(find('开始跟踪 0 个').hasAttribute('disabled')).toBe(true)
  })

  it('sends the refine text and shows the new batch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let current = view(FIVE)
    const { api } = await show(() => current, {}, {
      'POST tracks/:id/recommend': () => { current = running([], { batchId: 'b2', elapsedSec: 0 }); return { batchId: 'b2' } },
    })
    const input = document.querySelector<HTMLInputElement>('.op-refine input')!
    expect(input.maxLength).toBe(60)
    expect(input.placeholder).toBe('一句话调整，比如「多找些国内的」「去掉硬件类」')
    // Nothing to send while it is empty.
    expect(document.querySelector<HTMLButtonElement>('.op-refine button')!.disabled).toBe(true)
    await type(input, '多找些国内的')
    await submit('.op-refine')
    expect(requestsFor(api, 'tracks/t1/recommend').map(r => [r.method, r.body])).toEqual([['POST', { refine: '多找些国内的' }]])
    // The page reads at once: the new batch is running and empty, the box is cleared and waits.
    expect(status()).toBe('正在找…已找到 0 个 · 已用 0 秒')
    expect(names()).toEqual([])
    expect(input.value).toBe('')
    // Its candidates arrive as they are found, with the server's defaults (the old picks are gone with the old batch).
    const fresh = [cand('n1', '小米小爱同学', { batchId: 'b2' }), cand('n2', '荣耀 YOYO', { batchId: 'b2', tier: 'consider', selected: false })]
    current = running(fresh, { batchId: 'b2', elapsedSec: 20 })
    await advance(2000)
    expect(names()).toEqual(['小米小爱同学', '荣耀 YOYO'])
    expect(picked()).toEqual(['小米小爱同学'])
  })

  it('disables the refine box while it runs, and shows the server\'s answer if it still says no', async () => {
    const { api } = await show(running([doubao]))
    const input = document.querySelector<HTMLInputElement>('.op-refine input')!
    expect(input.disabled).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('.op-refine button')!.disabled).toBe(true)
    expect(document.querySelector('.op-pick-hint')?.textContent).toBe('上一轮还在找，找完才能调整。')
    expect(requestsFor(api, 'tracks/t1/recommend')).toHaveLength(0)
    unmount()
    // The run ended a moment ago, but the server still counts it as running: its sentence is shown, nothing is lost.
    const message = '上一轮推荐还在进行，稍等它结束再调整'
    await show(view(FIVE), {}, { 'POST tracks/:id/recommend': fail(409, message) })
    await type('.op-refine input', '去掉硬件类')
    await submit('.op-refine')
    expect(document.querySelector('.op-pick-problem')?.textContent).toBe(message)
    expect(document.querySelector<HTMLInputElement>('.op-refine input')!.value).toBe('去掉硬件类')
    expect(names()).toHaveLength(5)
  })

  it('writes 找到 n 篇 without bars when fewer than 5 articles are dated', async () => {
    await show(view([
      cand('c1', '有柱状图', { heat: heat() }),
      cand('c2', '日期太少', { heat: heat({ foundCount: 12, datedWeekly: [0, 0, 1, 1, 0], trend: 'unknown', showBars: false }) }),
      // Dated, but every article is older than five weeks: nothing to draw, and no 「平稳」 to claim.
      cand('c3', '都太旧', { heat: heat({ foundCount: 9, datedWeekly: [0, 0, 0, 0, 0], trend: 'flat', showBars: true }) }),
      cand('c4', '回落的', { heat: heat({ foundCount: 19, datedWeekly: [3, 5, 11, 9, 8], trend: 'down' }) }),
      cand('c5', '平稳的', { heat: heat({ foundCount: 22, datedWeekly: [9, 7, 6, 6, 7], trend: 'flat' }) }),
    ]))
    const heatOf = (name: string) => card(name).querySelector('.op-heat')!
    // The count is every article found, dated or not, old or new: it says no more than 「找到」.
    expect(heatOf('有柱状图').textContent).toBe('找到 41 篇相关报道 · 热度上升')
    expect(heatOf('有柱状图').querySelectorAll('.op-heat-bars i')).toHaveLength(5)
    expect(heatOf('回落的').textContent).toBe('找到 19 篇相关报道 · 回落')
    expect(heatOf('平稳的').textContent).toBe('找到 22 篇相关报道 · 平稳')
    // Without enough dates: just the number, and no chart.
    expect(heatOf('日期太少').textContent).toBe('找到 12 篇相关报道')
    expect(heatOf('日期太少').querySelector('.op-heat-bars')).toBeNull()
    // The bars are there only when they say something.
    expect(heatOf('都太旧').textContent).toBe('找到 9 篇相关报道')
    expect(heatOf('都太旧').querySelector('.op-heat-bars')).toBeNull()
    expect(text()).not.toContain('近 30 天')
  })

  it('shows what each candidate is: icon, name, company, form, one sentence and why', async () => {
    await show(view([muse, vivo]))
    const strong = card('Meta Muse')
    expect(strong.querySelector('.op-icon-tile')?.textContent).toBe('M')
    expect(strong.querySelector('.op-pick-co')?.textContent).toBe('Meta · 海外 · 独立 App + 眼镜')
    expect(strong.querySelector('.op-pick-one')?.textContent).toBe('Meta Muse是什么')
    expect(strong.querySelector('.op-pick-why')?.textContent).toBe('为什么推荐：Meta Muse为什么值得看')
    expect(card('某手机厂商代理').querySelector('.op-pick-co')?.textContent).toBe('某公司 · 国内 · App')
    // The ones worth considering are the compact cards: no sentence of what it is, no chart.
    expect(card('某手机厂商代理').hasAttribute('data-compact')).toBe(true)
    expect(card('某手机厂商代理').querySelector('.op-pick-one')).toBeNull()
    expect(card('某手机厂商代理').querySelector('.op-heat')).toBeNull()
    expect(card('某手机厂商代理').querySelector('.op-pick-why')?.textContent).toBe('为什么：某手机厂商代理为什么值得看')
    expect(strong.hasAttribute('data-compact')).toBe(false)
    // The check box is the card's own control, named by the product.
    expect(box('Meta Muse').getAttribute('aria-label')).toBe('Meta Muse')
  })

  it('groups the candidates and folds the ones that were not recommended, with why', async () => {
    await show(view([...FIVE, hardware, cand('c7', '某低质量套壳', { tier: 'excluded', selected: false, reason: '只是别人模型的壳' })]))
    expect(group('强烈推荐').querySelector('.op-pick-group-title')?.textContent).toBe('强烈推荐3')
    expect(names(group('强烈推荐'))).toEqual(['豆包·小豆', 'Meta Muse', 'OpenAI Dots'])
    expect(names(group('可以考虑'))).toEqual(['某手机厂商代理', '某开源个人代理'])
    // 全选这一组 belongs to the strong group only (and is there while they are all picked, as they are by default).
    expect(all('button').filter(b => b.textContent === '全选这一组')).toHaveLength(1)
    expect(group('强烈推荐').contains(find('全选这一组'))).toBe(true)
    // The excluded ones are one folded row: name and reason once it is opened; they cannot be picked.
    const fold = find('没推荐的 2 个')
    expect(fold.getAttribute('aria-expanded')).toBe('false')
    expect(text()).not.toContain('是硬件，不在关注范围')
    expect(footer()).toContain('已选 3 个')
    await click(fold)
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(all('.op-pick-excluded li').map(li => li.textContent)).toEqual(['某硬件挂件是硬件，不在关注范围', '某低质量套壳只是别人模型的壳'])
    expect(document.querySelector('.op-pick-excluded input')).toBeNull()
    await click(fold)
    expect(text()).not.toContain('是硬件，不在关注范围')
  })

  it('starts tracking the selected candidates', async () => {
    const { api, context } = await show(view(FIVE))
    await click(box('某开源个人代理'))
    await click(box('Meta Muse'))
    await click('开始跟踪 3 个')
    // The chosen ones, in the order shown; then the state is read again and the first product's page opens.
    expect(requestsFor(api, 'tracks/t1/start').map(r => [r.method, r.body])).toEqual([['POST', { candidateIds: ['c1', 'c3', 'c5'] }]])
    expect(context.refresh).toHaveBeenCalled()
    expect(context.navigate).toHaveBeenCalledWith({ page: 'product', productId: 'p-c1', tab: 'dossier' })
  })

  it('tells, only while the round runs, that what is found after starting goes to 候选推荐', async () => {
    const hint = '推荐还在进行，之后找到的候选会放进「候选推荐」'
    await show(running([doubao, muse]))
    expect(document.querySelector('.op-pick-early')?.textContent).toBe(hint)
    // It sits in the footer, with the button that starts; starting is still possible.
    expect(document.querySelector('.op-pick-foot')!.contains(document.querySelector('.op-pick-early'))).toBe(true)
    expect(find('开始跟踪 2 个').hasAttribute('disabled')).toBe(false)
    unmount()
    await show(view([doubao, muse]))
    expect(document.querySelector('.op-pick-early')).toBeNull()
    expect(text()).not.toContain('候选推荐')
  })

  it('says why starting failed and stays on the page', async () => {
    const { context } = await show(view(FIVE), {}, { 'POST tracks/:id/start': fail(400, '候选 c9 不是这个赛道的') })
    await click('开始跟踪 3 个')
    expect(document.querySelector('.op-pick-problem')?.textContent).toBe('候选 c9 不是这个赛道的')
    expect(context.navigate).not.toHaveBeenCalled()
    expect(picked()).toHaveLength(3)
  })

  it('goes back to today\'s brief on 稍后再挑 and keeps the picks', async () => {
    const { context } = await show(view(FIVE))
    await click(box('某开源个人代理'))
    await click('稍后再挑')
    expect(context.navigate).toHaveBeenCalledWith({ page: 'today' })
    unmount()
    await show(view(FIVE))
    expect(picked()).toEqual(['豆包·小豆', 'Meta Muse', 'OpenAI Dots', '某开源个人代理'])
  })

  it('lets you leave and come back to a running recommendation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let current = running([doubao, muse, vivo], { elapsedSec: 30 })
    await show(() => current)
    await click(box('Meta Muse'))
    await click(box('某手机厂商代理'))
    expect(picked()).toEqual(['豆包·小豆', '某手机厂商代理'])
    // Leave the page (it stops reading) …
    unmount()
    // … the recommendation goes on, and finds more.
    current = running([doubao, muse, dots, vivo, opensource], { elapsedSec: 95 })
    const { api } = await show(() => current)
    // Back: the same batch, still running, with what was picked kept; what arrived meanwhile starts with the defaults.
    expect(status()).toBe('正在找…已找到 5 个 · 已用 1 分 35 秒')
    expect(picked()).toEqual(['豆包·小豆', 'OpenAI Dots', '某手机厂商代理'])
    expect(requestsFor(api, 'tracks/t1/candidates').length).toBeGreaterThan(0)
    // It finishes while the page is open: still the same picks.
    current = view([doubao, muse, dots, vivo, opensource], { elapsedSec: 140 })
    await advance(2000)
    expect(status()).toBe('找到 5 个候选，按热度和贴合度排好 · 用时 2 分 20 秒')
    expect(picked()).toEqual(['豆包·小豆', 'OpenAI Dots', '某手机厂商代理'])
    // A newer batch starts over with the server's defaults.
    unmount()
    const next = [cand('n1', '小米小爱同学', { batchId: 'b2' }), cand('n2', '荣耀 YOYO', { batchId: 'b2', tier: 'consider', selected: false })]
    current = view(next, { batchId: 'b2' })
    await show(() => current)
    expect(picked()).toEqual(['小米小爱同学'])
  })

  it('reads every 2 s while it runs and every 30 s after, and at once when a new round starts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let current = running([doubao])
    const { api } = await show(() => current, {}, { 'POST tracks/:id/recommend': () => { current = running([], { batchId: 'b2' }); return { batchId: 'b2' } } })
    const reads = () => requestsFor(api, 'tracks/t1/candidates').length
    const before = reads()
    await advance(6000)
    expect(reads() - before).toBe(3)
    // Over: one more read sees it, then the pace drops to 30 s.
    current = view(FIVE)
    await advance(2000)
    const settled = reads()
    await advance(20_000)
    expect(reads()).toBe(settled)
    await advance(10_000)
    expect(reads()).toBe(settled + 1)
    // A refinement turns it quick again straight away, not after the slow wait in progress.
    await type('.op-refine input', '多找些国内的')
    await submit('.op-refine')
    const sent = reads()
    expect(status()).toContain('正在找…')
    await advance(4000)
    expect(reads() - sent).toBe(2)
  })
})

describe('when there is nothing to pick', () => {
  it('says the day\'s budget stopped it, and offers to try again', async () => {
    const { api } = await show(view([], { status: 'skipped', error: '今日总预算已用完' }))
    expect(names()).toEqual([])
    expect(document.querySelector('.op-pick-problem')?.textContent).toBe('没跑成：今日总预算已用完')
    expect(footer()).toContain('已选 0 个')
    await click('重新推荐')
    // A new round without an adjustment: no body at all.
    expect(requestsFor(api, 'tracks/t1/recommend').map(r => [r.method, r.body])).toEqual([['POST', undefined]])
  })

  it('says the recommendation failed, and why', async () => {
    await show(view([], { status: 'failed', error: '模型额度不足' }))
    expect(document.querySelector('.op-pick-problem')?.textContent).toBe('推荐失败：模型额度不足')
    expect(find('重新推荐')).toBeTruthy()
  })

  it('suggests another wording when it ran and found nothing suitable', async () => {
    await show(view([], { status: 'done' }))
    expect(document.querySelector('.op-pick-problem')?.textContent).toBe('这次没找到合适的候选，换个说法再试试')
    expect(all('button').find(b => b.textContent === '重新推荐')).toBeUndefined()
    // Not while it is still looking: that is the status line's story.
    unmount()
    await show(running([]))
    expect(document.querySelector('.op-pick-problem')).toBeNull()
    expect(status()).toBe('正在找…已找到 0 个 · 已用 42 秒')
  })

  it('still tells a failure that came after some candidates', async () => {
    await show(view([doubao], { status: 'failed', error: '搜索服务超时' }))
    expect(names()).toEqual(['豆包·小豆'])
    expect(document.querySelector('.op-pick-problem')?.textContent).toBe('推荐失败：搜索服务超时')
  })
})

describe('the footer', () => {
  const daily = (productId: string, costYuan: number, date = '2026-11-24', extra: Partial<Run> = {}): RunRow => ({
    id: `r-${productId}-${date}-${costYuan}`, kind: 'daily', date, trackId: null, productId, sessionId: null, status: 'done', startedAt: null, endedAt: null,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, costYuan, error: null, progress: null, subject: null, productName: productId, ...extra,
  })

  it('estimates from ¥0.5 to ¥1.0 a product a day until there are daily runs, and says it is an estimate', async () => {
    await show(view(FIVE))
    // Three picked: ¥1.5～3, with how long the first profiles take (3 at a time, about 5 minutes each).
    expect(footer()).toBe('已选 3 个预计每天 ¥1.5～3（估算） · 首次建档约 5 分钟，建好后明早出第一份哨报稍后再挑开始跟踪 3 个')
    await click(box('某手机厂商代理'))
    await click(box('某开源个人代理'))
    expect(footer()).toContain('预计每天 ¥2.5～5（估算） · 首次建档约 10 分钟')
  })

  it('estimates from what a product has cost a day lately, within 30%', async () => {
    const { api } = await show(view(FIVE), {}, {
      'GET runs': {
        runs: [
          daily('a', 0.8), daily('b', 1.2), daily('a', 1.0, '2026-11-23'),
          // Not counted: a run that cost nothing, and runs of other kinds.
          daily('c', 0, '2026-11-24'), { ...daily('d', 5), kind: 'baseline' }, daily('e', 3, '2026-11-24', { kind: 'verify' }),
        ],
      },
    })
    expect(api.requests.find(r => r.path === 'runs')!.query).toEqual({ days: '7' })
    // A product-day costs ¥1 on average: ¥3 for three, ±30%.
    expect(footer()).toContain('预计每天 ¥2.1～3.9（估算）')
    await click(box('某手机厂商代理'))
    expect(footer()).toContain('预计每天 ¥2.8～5.2（估算）')
  })

  it('adds two runs of one product on one day into one day\'s cost', async () => {
    await show(view(FIVE), {}, { 'GET runs': { runs: [daily('a', 0.4), daily('a', 0.6), daily('b', 1)] } })
    expect(footer()).toContain('预计每天 ¥2.1～3.9（估算）')
  })

  it('names no profile time for products Outpost already tracks', async () => {
    const tracked1 = cand('c1', '已跟踪的', { product: { status: 'tracking' } })
    await show(view([tracked1]))
    expect(footer()).toContain('已选 1 个')
    expect(footer()).not.toContain('首次建档')
  })
})

describe('a candidate that other tracks already follow', () => {
  it('marks a candidate tracked elsewhere and leaves it out of the daily estimate', async () => {
    const elsewhere = cand('c1', '豆包·小豆', { product: { status: 'tracking' }, trackedIn: ['Personal Agent'] })
    await show(view([elsewhere, muse]))
    // Both are ticked and both will be started; only the product Outpost does not follow yet is a new day's work.
    expect(picked()).toEqual(['豆包·小豆', 'Meta Muse'])
    expect(card('豆包·小豆').textContent).toContain('已在Personal Agent跟踪 · 只补缺的维度')
    expect(card('Meta Muse').textContent).not.toContain('跟踪')
    expect(box('豆包·小豆').disabled).toBe(false)
    expect(footer()).toContain('已选 2 个')
    expect(footer()).toContain('预计每天 ¥0.5～1（估算）') // one product: ¥0.5～1
    expect(find('开始跟踪 2 个')).toBeTruthy()
  })

  it('joins several track names with 、, and counts a twin tracked elsewhere neither in the estimate nor in the profile time', async () => {
    // This candidate is a row of its own (a candidate) for a product that two other tracks follow.
    const twin = cand('c1', '千问Go', { trackedIn: ['Personal Agent', '手机 AI 助理'] })
    await show(view([twin, muse, dots, vivo]))
    expect(card('千问Go').textContent).toContain('已在Personal Agent、手机 AI 助理跟踪 · 只补缺的维度')
    await click(box('某手机厂商代理'))
    // Four are ticked; three are new, which is what the estimate and the profile time (3 at a time) are about.
    expect(footer()).toContain('已选 4 个')
    expect(footer()).toContain('预计每天 ¥1.5～3（估算） · 首次建档约 5 分钟')
    // With only the one that is tracked elsewhere ticked there is no day's cost and no profile to build.
    for (const name of ['Meta Muse', 'OpenAI Dots', '某手机厂商代理']) await click(box(name))
    expect(footer()).toBe('已选 1 个稍后再挑开始跟踪 1 个')
  })

  it('says a product paused elsewhere is paused there, without promising missing dimensions, and leaves it out of the estimate', async () => {
    // Paused in two tracks: it neither runs nor gets topped up, so there is nothing to add for it here.
    const paused = cand('c1', 'Kimi助手', { trackedIn: ['Personal Agent', '手机 AI 助理'], trackedStatus: 'paused' })
    const building = cand('c3', 'OpenAI Dots', { trackedIn: ['AI 硬件'], trackedStatus: 'baselining' })
    await show(view([paused, muse, building]))
    expect(card('Kimi助手').querySelector('.op-pick-tracked')?.textContent).toBe('已在Personal Agent、手机 AI 助理暂停')
    expect(card('Kimi助手').textContent).not.toContain('只补缺的维度')
    expect(card('OpenAI Dots').querySelector('.op-pick-tracked')?.textContent).toBe('已在AI 硬件跟踪 · 只补缺的维度') // 建档中: as tracked
    expect(box('Kimi助手').disabled).toBe(false)
    // All three ticked; only Muse is a new day's work and a new profile.
    expect(footer()).toContain('已选 3 个')
    expect(footer()).toContain('预计每天 ¥0.5～1（估算） · 首次建档约 5 分钟')
  })
})

describe('a track that is already tracking', () => {
  it('shows the products already in it as tracked, not to be picked again', async () => {
    const already = cand('c1', '豆包·小豆', { product: { status: 'tracking' } })
    const active = state({ tracks: [track(TRACK, 'Personal Agent', [tracked(already.product)], { status: 'active', dimensions })] })
    const { context } = await show(view([already, muse]), { state: active }, { 'GET state': active })
    expect(card('豆包·小豆').textContent).toContain('已在跟踪')
    expect(box('豆包·小豆').disabled).toBe(true)
    expect(picked()).toEqual(['Meta Muse'])
    expect(footer()).toContain('已选 1 个')
    expect(context.setPicks).toHaveBeenLastCalledWith(TRACK, 1)
  })
})

// ---- step 1 ----

const created = state({ tracks: [track('t9', 'Personal Agent', [], { status: 'picking', brief: '个人代理', dimensions })] })
const form = () => document.querySelector<HTMLFormElement>('.op-track-form')!
const chips = () => all('.op-chip').map(chip => chip.textContent)

describe('step 1: saying what to follow', () => {
  const blank = () => mount(<NewTrack />, { state: state(), route: { page: 'newTrack' } })

  it('asks for a name and a sentence, with live counters, and shows the six dimensions', async () => {
    stubApi({ 'GET state': state() })
    await blank()
    expect(document.querySelector('h1')?.textContent).toBe('新建赛道')
    expect(all('.op-steps li').map(li => li.textContent)).toEqual(['说清关注什么', '挑产品', '建档'])
    expect(all('.op-steps li')[0]!.getAttribute('aria-current')).toBe('step')
    const nameField = document.querySelector<HTMLInputElement>('input[name="name"]')!
    const briefField = document.querySelector<HTMLTextAreaElement>('textarea[name="brief"]')!
    expect(nameField.maxLength).toBe(20)
    expect(briefField.maxLength).toBe(100)
    expect(all('.op-field-count').map(c => c.textContent)).toEqual(['0/20', '0/100'])
    await type(nameField, 'Personal Agent')
    await type(briefField, '能替人跨 App 办事的个人代理')
    expect(all('.op-field-count').map(c => c.textContent)).toEqual(['14/20', '16/100'])
    // The six default dimensions are labels, not controls; 「＋ 维度」 adds one.
    expect(chips()).toEqual(['定位', '目标人群', '价值场景', '体验', '关键技术', '商业化', '＋ 维度'])
    expect(all('button.op-chip').map(b => b.textContent)).toEqual(['＋ 维度'])
    expect(all('.op-chip button')).toHaveLength(0)
  })

  it('needs a name before it can go on', async () => {
    stubApi({ 'GET state': state() })
    await blank()
    const go = find('开始找候选')
    expect(go.hasAttribute('disabled')).toBe(true)
    await type('input[name="name"]', '   ')
    expect(go.hasAttribute('disabled')).toBe(true)
    await type('input[name="name"]', 'AI 眼镜')
    expect(go.hasAttribute('disabled')).toBe(false)
  })

  it('adds custom dimensions, which can be taken away again before it goes on', async () => {
    stubApi({ 'GET state': state() })
    await blank()
    await click('＋ 维度')
    const dimension = document.querySelector<HTMLInputElement>('input[name="dimension"]')!
    expect(dimension.maxLength).toBe(20)
    await type(dimension, '记忆')
    await click('添加')
    expect(chips()).toEqual(['定位', '目标人群', '价值场景', '体验', '关键技术', '商业化', '记忆×', '＋ 维度'])
    // Enter adds too, and does not submit the form.
    await click('＋ 维度')
    await type('input[name="dimension"]', '隐私')
    await act(async () => { document.querySelector('input[name="dimension"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await settle()
    expect(chips().slice(6)).toEqual(['记忆×', '隐私×', '＋ 维度'])
    // A label that is already there is not added again; an empty one is not added at all.
    await click('＋ 维度')
    await type('input[name="dimension"]', ' 定位 ')
    await click('添加')
    await click('＋ 维度')
    await click('添加')
    expect(chips().slice(6)).toEqual(['记忆×', '隐私×', '＋ 维度'])
    await click(find('去掉维度「记忆」'))
    expect(chips().slice(6)).toEqual(['隐私×', '＋ 维度'])
  })

  it('creates the track, finds candidates, and goes to the picking page of the new track', async () => {
    const api = stubApi({ 'GET state': state(), 'POST tracks': { trackId: 't9', batchId: 'b1' } })
    const context = await blank()
    await type('input[name="name"]', '  Personal Agent ')
    await type('textarea[name="brief"]', '个人代理')
    await click('＋ 维度')
    await type('input[name="dimension"]', '记忆')
    await click('添加')
    await submit(form())
    expect(api.requests.filter(r => r.method === 'POST').map(r => [r.path, r.body])).toEqual([
      ['tracks', { name: 'Personal Agent', brief: '个人代理', extraDimensions: ['记忆'] }],
    ])
    expect(context.refresh).toHaveBeenCalled()
    expect(context.navigate).toHaveBeenCalledWith({ page: 'newTrack', trackId: 't9' })
  })

  it('takes a dimension that was typed but not added along with the form, instead of dropping it', async () => {
    const api = stubApi({ 'GET state': state(), 'POST tracks': { trackId: 't9', batchId: 'b1' } })
    await blank()
    await type('input[name="name"]', 'Personal Agent')
    await click('＋ 维度')
    await type('input[name="dimension"]', ' 记忆 ')
    await submit(form())
    expect(api.requests.filter(r => r.method === 'POST').map(r => r.body)).toEqual([{ name: 'Personal Agent', brief: '', extraDimensions: ['记忆'] }])
    unmount()
    // One that is already there (or nothing at all) adds nothing, and does not stop the form.
    const again = stubApi({ 'GET state': state(), 'POST tracks': { trackId: 't9', batchId: 'b1' } })
    await blank()
    await type('input[name="name"]', 'Personal Agent')
    await click('＋ 维度')
    await type('input[name="dimension"]', '体验')
    await submit(form())
    expect(again.requests.filter(r => r.method === 'POST').map(r => r.body)).toEqual([{ name: 'Personal Agent', brief: '', extraDimensions: [] }])
  })

  it('says why the track could not be created and keeps what was typed', async () => {
    stubApi({ 'GET state': state(), 'POST tracks': fail(400, 'name must be at most 20 characters') })
    const context = await blank()
    await type('input[name="name"]', 'Personal Agent')
    await submit(form())
    expect(document.querySelector('.op-form-problem')?.textContent).toBe('name must be at most 20 characters')
    expect(document.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('Personal Agent')
    expect(context.navigate).not.toHaveBeenCalled()
  })

  it('shows the form as a summary block once it is sent, and 改 changes it', async () => {
    const api = stubApi({
      'GET state': created, 'GET tracks/:id/candidates': view([]), 'GET runs': { runs: [] },
      'PATCH tracks/:id': { ...created.tracks[0]!.track, name: 'Agent 们' },
    })
    const context = await mount(<NewTrack />, { state: created, route: { page: 'newTrack', trackId: 't9' } })
    // The form has collapsed: step 1 is done, the name is the title, what was asked is in the block.
    expect(document.querySelector('.op-track-form')).toBeNull()
    expect(all('.op-steps li')[0]!.getAttribute('data-state')).toBe('done')
    expect(all('.op-steps li')[1]!.getAttribute('aria-current')).toBe('step')
    expect(document.querySelector('h1')?.textContent).toBe('Personal Agent')
    const summary = document.querySelector('.op-track-summary')!
    expect(summary.textContent).toContain('个人代理')
    expect([...summary.querySelectorAll('.op-chip')].map(chip => chip.textContent)).toEqual(['定位', '目标人群', '价值场景', '体验', '关键技术', '商业化', '记忆'])
    // 改 opens it again with what the track has; saving sends the change and reads the state again.
    await click('改')
    expect(document.querySelector<HTMLInputElement>('input[name="name"]')!.value).toBe('Personal Agent')
    expect(document.querySelector<HTMLTextAreaElement>('textarea[name="brief"]')!.value).toBe('个人代理')
    expect(chips()).toEqual(['定位', '目标人群', '价值场景', '体验', '关键技术', '商业化', '记忆×', '＋ 维度'])
    await type('input[name="name"]', 'Agent 们')
    await click(find('去掉维度「记忆」'))
    await click('保存')
    expect(api.requests.filter(r => r.method === 'PATCH').map(r => [r.path, r.body])).toEqual([
      ['tracks/t9', { name: 'Agent 们', brief: '个人代理', extraDimensions: [] }],
    ])
    expect(context.refresh).toHaveBeenCalled()
    expect(document.querySelector('.op-track-form')).toBeNull()
    // A dimension typed in 改 but not added is saved too.
    await click('改')
    await click('＋ 维度')
    await type('input[name="dimension"]', '隐私')
    await click('保存')
    expect(api.requests.filter(r => r.method === 'PATCH').at(-1)!.body).toEqual({ name: 'Personal Agent', brief: '个人代理', extraDimensions: ['记忆', '隐私'] })
    expect(document.querySelector('.op-track-form')).toBeNull()
    // Leaving the edit untouched sends nothing.
    await click('改')
    await click('取消')
    expect(api.requests.filter(r => r.method === 'PATCH')).toHaveLength(2)
    expect(document.querySelector('.op-track-form')).toBeNull()
  })
})

describe('the style of the page', () => {
  const css = readFileSync(join(process.cwd(), 'src/client/styles.css'), 'utf8')
  it('fills the width with a grid of cards from 270px, and keeps the footer in view', () => {
    expect(css).toMatch(/\.op-pick-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(270px,\s*1fr\)\)/)
    expect(css).toMatch(/\.op-pick-foot\s*\{[^}]*position:\s*sticky/)
  })
})
