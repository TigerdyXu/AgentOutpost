// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunKind } from '../../src/core/types.ts'
import type { RunRow, StateView } from '../../src/host/api.ts'
import { AddProduct } from '../../src/client/pages/AddProduct.tsx'
import { ShellContext, useShell, type Shell } from '../../src/client/shell/context.ts'
import { all, click, fail, find, mount, product, productView, run, settle, state, stubApi, submit, text, track, tracked, type, unmount } from '../fixtures/client.tsx'

// ---- the track "Personal Agent" (t1) holds Meta Muse; "AI 眼镜" (t2) follows Ray-Ban Meta, a paused 雷鸟 and a 智能戒指 still being profiled ----

const TRACK = 't1'
const muse = product('p1', 'Meta Muse')
const rayban = product('p2', 'Ray-Ban Meta')
const rokid = product('p3', '雷鸟', { status: 'paused' })
const ring = product('p5', '智能戒指', { status: 'baselining' })
const here = track(TRACK, 'Personal Agent', [tracked(muse)])
const glasses = track('t2', 'AI 眼镜', [tracked(rayban), tracked(rokid), tracked(ring)])
const board = state({ tracks: [here, glasses] })

/** A run of the kind the page watches, for t1. */
const confirm = (id: string, status: RunRow['status'], extra: Partial<RunRow> = {}): RunRow =>
  run(id, null, status, { kind: 'identify', trackId: TRACK, subject: 'Gemini Agent', ...extra })
const recommend = (id: string, status: RunRow['status'], extra: Partial<RunRow> = {}): RunRow =>
  run(id, null, status, { kind: 'recommend' as RunKind, trackId: TRACK, ...extra })

/** The page of `t1` over a stubbed API; `runs` is what `GET runs` answers now (a variable the test may change). */
function setup(initial: RunRow[] = []) {
  const box = { runs: initial }
  return {
    box,
    async show(routes: Record<string, unknown> = {}, shell: Partial<Shell> = {}) {
      const api = stubApi({ 'GET runs': () => ({ runs: box.runs }), 'GET products/:id': productView(rayban), ...routes })
      const context = await mount(<AddProduct />, { state: board, route: { page: 'addProduct', trackId: TRACK }, ...shell })
      return { api, context }
    },
  }
}

const requestsFor = (api: ReturnType<typeof stubApi>, method: string, path: string) => api.requests.filter(r => r.method === method && r.path === path)
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }); await settle() }
const fakeTimers = () => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) }
const nameField = () => document.querySelector<HTMLInputElement>('.op-add-byname input[name="name"]')!
const urlField = () => document.querySelector<HTMLInputElement>('.op-add-byname input[name="officialUrl"]')!
const refineField = () => document.querySelector<HTMLInputElement>('.op-add-again input[name="refine"]')!
const results = () => all('.op-add-result')
const lines = () => results().map(r => r.querySelector('.op-add-line')?.textContent)
const submitName = async (name: string, url = '') => {
  await type(nameField(), name)
  if (url) await type(urlField(), url)
  await submit('.op-add-byname')
}

afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('the page', () => {
  it('is titled by the track and has the two sections, one above the other', async () => {
    await setup().show()
    expect(document.querySelector('h1')?.textContent).toBe('给「Personal Agent」添加产品')
    expect(all('.op-add-section h2').map(h => h.textContent)).toEqual(['知道名字', '让前哨再找一轮'])
    // The form of the first: a name with its example, the site that may be left out, and the button that starts it.
    expect(nameField().placeholder).toBe('如 Gemini Agent')
    expect(document.querySelector('.op-add-byname')!.textContent).toContain('官网（可不填）')
    expect(find('加入并建档')).toBeTruthy()
    // The second: the one-sentence request that may be left out, the button, and what a round costs.
    expect(document.querySelector('.op-add-again')!.textContent).toContain('一句话要求（可不填）')
    expect(find('再推荐一批').hasAttribute('disabled')).toBe(false)
    expect(text()).toContain('约 ¥0.5、3–4 分钟')
    // Nothing has happened yet: no result, no way to the suggestions.
    expect(results()).toHaveLength(0)
    expect(() => find('去「候选推荐」看')).toThrow()
  })

  it('says so when the track is not there (archived, or gone), without a form', async () => {
    await setup().show({}, { route: { page: 'addProduct', trackId: 'gone' } })
    expect(text()).toContain('找不到这个赛道')
    expect(document.querySelector('form')).toBeNull()
  })
})

describe('adding by name', () => {
  it('adds a product by name and shows it is being confirmed, then joined', async () => {
    fakeTimers()
    const gemini = product('p9', 'Gemini Agent', { status: 'baselining', company: 'Google' })
    const s = setup()
    const { api, context } = await s.show({
      'POST tracks/:id/add-product': () => { s.box.runs = [confirm('r1', 'running')]; return { runId: 'r1' } },
      'GET products/:id': productView(gemini),
    })
    await submitName('Gemini Agent', 'https://gemini.google.com')
    // The typed name and site went to the track; the form is ready for the next one.
    expect(requestsFor(api, 'POST', 'tracks/t1/add-product').map(r => r.body)).toEqual([{ name: 'Gemini Agent', officialUrl: 'https://gemini.google.com' }])
    expect(nameField().value).toBe('')
    expect(urlField().value).toBe('')
    // It is being confirmed: the name the user typed, and what is going on.
    expect(results()).toHaveLength(1)
    expect(results()[0]!.textContent).toContain('Gemini Agent')
    expect(lines()).toEqual(['正在确认这个产品…'])
    expect(() => find('Gemini Agent')).toThrow() // no product page to go to yet

    // The run passes: the product joined and is being profiled, with a way to its page; the column reads again.
    s.box.runs = [confirm('r1', 'done', { productId: 'p9', productName: 'Gemini Agent' })]
    await advance(2000)
    expect(lines()).toEqual(['已加入，正在建档'])
    expect(context.refresh).toHaveBeenCalled()
    await click(find('Gemini Agent'))
    expect(context.navigate).toHaveBeenCalledWith({ page: 'product', productId: 'p9', tab: 'dossier' })
  })

  it('leaves the site out of the request when it is blank', async () => {
    const s = setup()
    const { api } = await s.show({ 'POST tracks/:id/add-product': () => { s.box.runs = [confirm('r1', 'queued')]; return { runId: 'r1' } } })
    await submitName('  Gemini Agent  ', '  ')
    expect(requestsFor(api, 'POST', 'tracks/t1/add-product').map(r => r.body)).toEqual([{ name: 'Gemini Agent' }])
  })

  it('keeps what it said once it is said: the profile finishing later does not turn it into another line', async () => {
    fakeTimers()
    const s = setup()
    let status: 'baselining' | 'tracking' = 'baselining'
    const { api } = await s.show({
      'POST tracks/:id/add-product': () => { s.box.runs = [confirm('r1', 'running')]; return { runId: 'r1' } },
      'GET products/:id': () => productView(product('p9', 'Gemini Agent', { status })),
    })
    await submitName('Gemini Agent')
    s.box.runs = [confirm('r1', 'done', { productId: 'p9', productName: 'Gemini Agent' })]
    await advance(2000)
    expect(lines()).toEqual(['已加入，正在建档'])
    // Minutes later the profile is done (a tracked product now): the line stays what it was when the run ended.
    status = 'tracking'
    await advance(60_000)
    expect(lines()).toEqual(['已加入，正在建档'])
    expect(requestsFor(api, 'GET', 'products/p9')).toHaveLength(1)
  })

  it('says why a product was not added', async () => {
    fakeTimers()
    const s = setup()
    let n = 0
    await s.show({ 'POST tracks/:id/add-product': () => ({ runId: `r${++n}` }) })
    // The check ended with a remark and no product: the reason, as the agent gave it.
    await submitName('产品1')
    expect(lines()).toEqual(['正在确认这个产品…'])
    const refused = confirm('r1', 'done', { subject: '产品1', error: '找不到叫这个名字的产品' })
    s.box.runs = [refused]
    await advance(2000)
    expect(lines()).toEqual(['没加进来：找不到叫这个名字的产品'])
    expect(results()[0]!.getAttribute('data-state')).toBe('fail')
    // It failed, or was skipped for the budget: the same, with the run's own sentence.
    await submitName('产品2')
    const failed = confirm('r2', 'failed', { subject: '产品2', error: '处理结果时出错' })
    s.box.runs = [refused, failed]
    await advance(2000)
    await submitName('产品3')
    s.box.runs = [refused, failed, confirm('r3', 'skipped', { subject: '产品3', error: '今天的预算已用完' })]
    await advance(2000)
    expect(lines()).toEqual(['没加进来：今天的预算已用完', '没加进来：处理结果时出错', '没加进来：找不到叫这个名字的产品'])
    // Nothing to open: no product came of any of them.
    expect(all('.op-add-result button')).toHaveLength(0)
  })

  it('says a product tracked elsewhere was added at once', async () => {
    const { show } = setup()
    const { api, context } = await show({ 'POST tracks/:id/add-product': { linked: 'p2', status: 'tracking' } })
    await submitName('Ray-Ban Meta')
    expect(lines()).toEqual(['已在「AI 眼镜」跟踪，直接加进来了 · 只补缺的维度'])
    // No confirmation was asked for: nothing to wait on, and the column shows the product in this track now.
    expect(requestsFor(api, 'GET', 'runs').length).toBeGreaterThan(0)
    expect(context.refresh).toHaveBeenCalled()
    expect(results()[0]!.getAttribute('data-state')).toBe('ok')
    await click(find('Ray-Ban Meta'))
    expect(context.navigate).toHaveBeenCalledWith({ page: 'product', productId: 'p2', tab: 'dossier' })
  })

  it('says a followed product that is still being profiled is being profiled, with its page, like a confirmed one', async () => {
    const { context } = await setup().show({ 'POST tracks/:id/add-product': { linked: 'p5', status: 'baselining' } })
    await submitName('智能戒指')
    // Not 「已在…跟踪」: nothing tracks it yet, its profile is being built.
    expect(lines()).toEqual(['已加入，正在建档'])
    expect(results()[0]!.getAttribute('data-state')).toBe('ok')
    await click(find('智能戒指'))
    expect(context.navigate).toHaveBeenCalledWith({ page: 'product', productId: 'p5', tab: 'dossier' })
  })

  it('says a paused product was added but is still paused, and one already in the track is already there', async () => {
    let answer: unknown = { linked: 'p3', status: 'paused' }
    await setup().show({ 'POST tracks/:id/add-product': () => answer })
    await submitName('雷鸟')
    expect(lines()).toEqual(['已在「AI 眼镜」暂停，加进来了 · 仍是暂停'])
    answer = { linked: 'p1', status: 'tracking', already: true }
    await submitName('Meta Muse')
    expect(lines()).toEqual(['已经在「Personal Agent」里了', '已在「AI 眼镜」暂停，加进来了 · 仍是暂停'])
  })

  it('judges a finished confirmation by the track as it was when sent, and by where the product stands now', async () => {
    fakeTimers()
    const s = setup()
    const reply: { answer: unknown; status: 'tracking' | 'paused' } = { answer: { runId: 'r1' }, status: 'tracking' }
    await s.show({
      'POST tracks/:id/add-product': () => { s.box.runs = [confirm('r1', 'running')]; return reply.answer },
      'GET products/:id': () => productView({ ...rayban, status: reply.status }),
    })
    // The product the confirmation settled on was in the track already (typed another way): nothing changed.
    await submitName('麦塔缪斯')
    s.box.runs = [confirm('r1', 'done', { subject: '麦塔缪斯', productId: 'p1', productName: 'Meta Muse' })]
    await advance(2000)
    expect(lines()).toEqual(['已经在「Personal Agent」里了'])
    // A followed product it found under that name, joined as it is: the tracked line.
    reply.answer = { runId: 'r2' }
    await submitName('雷鸟之外')
    s.box.runs = [confirm('r1', 'done', { subject: '麦塔缪斯', productId: 'p1', productName: 'Meta Muse' }), confirm('r2', 'done', { subject: '雷鸟之外', productId: 'p2', productName: 'Ray-Ban Meta' })]
    await advance(2000)
    expect(lines()[0]).toBe('已在「AI 眼镜」跟踪，直接加进来了 · 只补缺的维度')
    // The same, but paused.
    reply.answer = { runId: 'r3' }
    reply.status = 'paused'
    await submitName('又一个')
    s.box.runs = [...s.box.runs, confirm('r3', 'done', { subject: '又一个', productId: 'p2', productName: 'Ray-Ban Meta' })]
    await advance(2000)
    expect(lines()[0]).toBe('已在「AI 眼镜」暂停，加进来了 · 仍是暂停')
  })

  it('judges by the snapshot taken when sent, not by the track as the state has it when the run ends', async () => {
    fakeTimers()
    const s = setup()
    // The column reads the state again after the submit, and the new product is in the track by the time the run is over.
    const ctl: { show?: (next: StateView) => void } = {}
    function Rerenders() {
      const shell = useShell()
      const [current, setCurrent] = useState(shell.state)
      ctl.show = setCurrent
      return <ShellContext.Provider value={{ ...shell, state: current }}><AddProduct /></ShellContext.Provider>
    }
    const gemini = product('p9', 'Gemini Agent', { status: 'baselining' })
    stubApi({
      'GET runs': () => ({ runs: s.box.runs }), 'GET products/:id': productView(gemini),
      'POST tracks/:id/add-product': () => { s.box.runs = [confirm('r1', 'running')]; return { runId: 'r1' } },
    })
    await mount(<Rerenders />, { state: board, route: { page: 'addProduct', trackId: TRACK } })
    await submitName('Gemini Agent')
    expect(lines()).toEqual(['正在确认这个产品…'])
    await act(async () => { ctl.show!(state({ tracks: [track(TRACK, 'Personal Agent', [tracked(muse), tracked(gemini)]), glasses] })) })
    s.box.runs = [confirm('r1', 'done', { productId: 'p9', productName: 'Gemini Agent' })]
    await advance(2000)
    // It was not in the track when it was sent, so it is not 「已经在…里了」.
    expect(lines()).toEqual(['已加入，正在建档'])
  })

  it('shows one line for a name asked twice while it is being confirmed', async () => {
    const s = setup()
    const { api } = await s.show({ 'POST tracks/:id/add-product': () => { s.box.runs = [confirm('r1', 'running')]; return { runId: 'r1' } } })
    await submitName('Gemini Agent')
    await submitName('Gemini Agent')
    expect(requestsFor(api, 'POST', 'tracks/t1/add-product')).toHaveLength(2)
    expect(results()).toHaveLength(1)
  })

  it('shows the server’s sentence when it refuses, and keeps what was typed', async () => {
    await setup().show({ 'POST tracks/:id/add-product': fail(409, '这个赛道已归档') })
    await submitName('Gemini Agent', 'https://gemini.google.com')
    expect(document.querySelector('.op-add-byname [role="alert"]')?.textContent).toBe('这个赛道已归档')
    expect(nameField().value).toBe('Gemini Agent')
    expect(urlField().value).toBe('https://gemini.google.com')
    expect(results()).toHaveLength(0)
    expect(find('加入并建档').hasAttribute('disabled')).toBe(false)
  })

  it('the name is required and the url must be http(s)', async () => {
    const { api } = await setup().show({ 'POST tracks/:id/add-product': { runId: 'r1' } })
    // Nothing is sent without a name (blank counts as none), and the field says what is wrong.
    await submit('.op-add-byname')
    expect(document.querySelector('.op-add-byname [role="alert"]')?.textContent).toBe('请填产品名')
    expect(nameField().getAttribute('aria-invalid')).toBe('true')
    await type(nameField(), '   ')
    await submit('.op-add-byname')
    expect(document.querySelector('.op-add-byname [role="alert"]')?.textContent).toBe('请填产品名')
    // A site that is not an http(s) address is stopped the same way, whatever it looks like.
    await type(nameField(), 'Gemini Agent')
    expect(document.querySelector('.op-add-byname [role="alert"]')).toBeNull()
    for (const bad of ['gemini.google.com', 'ftp://gemini.google.com', 'javascript:alert(1)', 'https://']) {
      await type(urlField(), bad)
      await submit('.op-add-byname')
      expect(document.querySelector('.op-add-byname [role="alert"]')?.textContent, bad).toBe('官网要以 http:// 或 https:// 开头')
      expect(urlField().getAttribute('aria-invalid')).toBe('true')
    }
    expect(requestsFor(api, 'POST', 'tracks/t1/add-product')).toHaveLength(0)
    // Typing again takes the complaint away; a good address goes through.
    await type(urlField(), 'http://gemini.google.com/agent')
    expect(document.querySelector('.op-add-byname [role="alert"]')).toBeNull()
    await submit('.op-add-byname')
    expect(requestsFor(api, 'POST', 'tracks/t1/add-product').map(r => r.body)).toEqual([{ name: 'Gemini Agent', officialUrl: 'http://gemini.google.com/agent' }])
  })

  it('picks up a confirmation still running when the page is opened again', async () => {
    const s = setup([confirm('r1', 'running', { subject: 'Gemini Agent' }), confirm('r0', 'running', { subject: '别的赛道的', trackId: 't2' }), confirm('r9', 'done', { subject: '早先的', error: '找不到' })])
    await s.show()
    expect(results()).toHaveLength(1)
    expect(results()[0]!.textContent).toContain('Gemini Agent')
    expect(lines()).toEqual(['正在确认这个产品…'])
  })
})

describe('asking for another batch', () => {
  it('asks for another batch with the adjustment and points to the suggestions', async () => {
    fakeTimers()
    const s = setup()
    const { api, context } = await s.show({ 'POST tracks/:id/recommend': () => { s.box.runs = [recommend('r5', 'running')]; return { batchId: 'r5' } } })
    expect(refineField().maxLength).toBe(60)
    await type(refineField(), '多找些国内的')
    await submit('.op-add-again')
    expect(requestsFor(api, 'POST', 'tracks/t1/recommend').map(r => r.body)).toEqual([{ refine: '多找些国内的' }])
    // It is looking: the button says so and waits, the box is cleared, and the suggestions are one click away.
    expect(find('正在找…').hasAttribute('disabled')).toBe(true)
    expect(refineField().value).toBe('')
    expect(context.refresh).toHaveBeenCalled()
    await click(find('去「候选推荐」看'))
    expect(context.navigate).toHaveBeenCalledWith({ page: 'newTrack', trackId: TRACK })
    // When the round is over the button asks again, and the way to the suggestions stays.
    s.box.runs = [recommend('r5', 'done')]
    await advance(2000)
    expect(find('再推荐一批').hasAttribute('disabled')).toBe(false)
    expect(find('去「候选推荐」看')).toBeTruthy()
  })

  it('asks without an adjustment too', async () => {
    const s = setup()
    const { api } = await s.show({ 'POST tracks/:id/recommend': () => { s.box.runs = [recommend('r5', 'queued')]; return { batchId: 'r5' } } })
    await click('再推荐一批')
    expect(requestsFor(api, 'POST', 'tracks/t1/recommend').map(r => r.body ?? {})).toEqual([{}])
    expect(find('正在找…')).toBeTruthy()
  })

  it('shows 正在找… when one is already running (409), with no complaint', async () => {
    const s = setup([recommend('r4', 'running')])
    await s.show({ 'POST tracks/:id/recommend': fail(409, '上一轮推荐还在进行，稍等它结束再调整') })
    // It was found running when the page opened.
    expect(find('正在找…').hasAttribute('disabled')).toBe(true)
    expect(find('去「候选推荐」看')).toBeTruthy()
    unmount()

    // The server says it is running although this page had not seen it: the same, and the sentence is not shown.
    const t = setup()
    const { api } = await t.show({ 'POST tracks/:id/recommend': () => { t.box.runs = [recommend('r4', 'running')]; return fail(409, '上一轮推荐还在进行，稍等它结束再调整') } })
    await type(refineField(), '去掉硬件类')
    await submit('.op-add-again')
    expect(requestsFor(api, 'POST', 'tracks/t1/recommend')).toHaveLength(1)
    expect(find('正在找…').hasAttribute('disabled')).toBe(true)
    expect(find('去「候选推荐」看')).toBeTruthy()
    expect(text()).not.toContain('稍等它结束再调整')
    expect(document.querySelector('.op-add-again [role="alert"]')).toBeNull()
  })

  it('also reads the column’s own word that it is searching', async () => {
    await setup().show({}, { state: state({ tracks: [{ ...here, recommending: true }, glasses] }) })
    expect(find('正在找…').hasAttribute('disabled')).toBe(true)
  })

  it('explains a round the budget turned away at once, though the first reading after the ask already says skipped', async () => {
    const s = setup()
    // The host finishes a refused round before it answers, and the batch it names is that run: it is never seen running.
    const { api } = await s.show({
      'POST tracks/:id/recommend': () => { s.box.runs = [recommend('r8', 'skipped', { error: '今日总预算已用完' })]; return { batchId: 'r8' } },
    })
    await click('再推荐一批')
    expect(requestsFor(api, 'POST', 'tracks/t1/recommend')).toHaveLength(1)
    expect(document.querySelector('.op-add-again [role="status"]')?.textContent).toBe('没跑成：今日总预算已用完')
    expect(find('再推荐一批').hasAttribute('disabled')).toBe(false)
    // The way to the suggestions stays: the user asked, and they may want to see what is there.
    expect(find('去「候选推荐」看')).toBeTruthy()
  })

  it('shows any other failure, and says how a round it asked for ended when it did not run', async () => {
    fakeTimers()
    const s = setup()
    let broken = true
    await s.show({
      'POST tracks/:id/recommend': () => {
        if (broken) return fail(500, '前哨内部出错，详情见 DSH 日志')
        s.box.runs = [recommend('r6', 'running')]
        return { batchId: 'r6' }
      },
    })
    await click('再推荐一批')
    expect(document.querySelector('.op-add-again [role="alert"]')?.textContent).toBe('前哨内部出错，详情见 DSH 日志')
    expect(find('再推荐一批').hasAttribute('disabled')).toBe(false)
    // It starts this time, and is refused for the budget a moment later: the reason, in the words of the picking page.
    broken = false
    await click('再推荐一批')
    expect(document.querySelector('.op-add-again [role="alert"]')).toBeNull()
    s.box.runs = [recommend('r6', 'skipped', { error: '今天的预算已用完' })]
    await advance(2000)
    expect(document.querySelector('.op-add-again [role="status"]')?.textContent).toBe('没跑成：今天的预算已用完')
    expect(find('再推荐一批').hasAttribute('disabled')).toBe(false)
    // One that failed gives its reason the same way.
    await click('再推荐一批')
    s.box.runs = [recommend('r7', 'running')]
    await advance(2000)
    s.box.runs = [recommend('r7', 'failed', { error: '会话超时' })]
    await advance(2000)
    expect(document.querySelector('.op-add-again [role="status"]')?.textContent).toBe('推荐失败：会话超时')
    // An earlier failure the page never saw running is not its news.
    unmount()
    await setup([recommend('r1', 'failed', { error: '旧的失败' })]).show()
    expect(text()).not.toContain('旧的失败')
  })
})

describe('keeping up', () => {
  it('reads the runs every 2 seconds while it is open, and stops when it is left', async () => {
    fakeTimers()
    const { api } = await setup().show()
    const reads = () => requestsFor(api, 'GET', 'runs').length
    const first = reads()
    expect(first).toBeGreaterThan(0)
    expect(api.requests.find(r => r.path === 'runs')!.query).toEqual({ days: '2' })
    await advance(6000)
    expect(reads() - first).toBe(3)
    unmount()
    const left = reads()
    await advance(20_000)
    expect(reads()).toBe(left)
  })
})

describe('the style of the quiet row', () => {
  it('never lets its hover colour reach the selected row (a jsdom test cannot compare specificity, so the selectors are read)', () => {
    const css = readFileSync(join(process.cwd(), 'src/client/styles.css'), 'utf8')
    const hovers = [...css.matchAll(/([^{}]*\[data-quiet\][^{}]*:hover[^{}]*)\{/g)].map(match => match[1]!.trim())
    expect(hovers.length).toBeGreaterThan(0)
    // `.op-row[data-quiet]:hover` outweighs `.op-row[aria-current="page"]`: the selected row would lose its blue.
    for (const selector of hovers) expect(selector).toContain(':not([aria-current="page"])')
  })
})
