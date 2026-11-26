// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunRow } from '../../src/host/api.ts'
import { STOPPED_ERROR } from '../../src/host/jobs/runner.ts'
import { VERIFY_BUDGET_NOTE } from '../../src/host/jobs/daily.ts'
import { Runs } from '../../src/client/pages/Runs.tsx'
import { STOPPED } from '../../src/client/notes.ts'
import type { Shell } from '../../src/client/shell/context.ts'
import { all, click, fail, mount, product, run, settle, state, stubApi, t, text, track, tracked, unmount } from '../fixtures/client.tsx'

afterEach(() => { unmount(); vi.unstubAllGlobals(); vi.useRealTimers() })

// ---- runs to read: today (2026-11-25), yesterday, and an earlier day ----

/** An instant (UTC) as the host stores it. */
const at = (day: string, hhmm: string, seconds = 0) => `${day}T${hhmm}:${String(seconds).padStart(2, '0')}.000Z`

const shellState = state({
  tracks: [track('t1', 'Personal Agent', [tracked(product('p1', '豆包·小豆')), tracked(product('p2', 'Meta Muse'))])],
})

/** The page's rows, by run id order of appearance, and one row's cells. */
const rows = () => all('.op-run')
const cells = (row: Element) => ({
  kind: row.querySelector('.op-run-kind')?.textContent,
  object: row.querySelector('.op-run-object')?.textContent,
  status: row.querySelector('.op-run-status')?.textContent,
  time: row.querySelector('.op-run-time')?.textContent,
  cost: row.querySelector('.op-run-cost')?.textContent,
  note: row.querySelector('.op-run-note')?.textContent ?? null,
})
const rowOf = (object: string, kind?: string) => rows().find(row => row.querySelector('.op-run-object')?.textContent === object
  && (kind === undefined || row.querySelector('.op-run-kind')?.textContent === kind))!
const inside = (row: Element, name: string) => [...row.querySelectorAll<HTMLElement>('button')].find(button => button.textContent?.trim() === name)

/** The runs page over a stubbed API; the shell can be overridden (the sessions it opens, say). */
async function show(runs: RunRow[] | ReturnType<typeof fail>, shell: Partial<Shell> = {}, extra: Record<string, unknown> = {}) {
  const api = stubApi({ 'GET state': shellState, 'GET runs': Array.isArray(runs) ? { runs } : runs, ...extra })
  const context = await mount(<Runs />, { state: shellState, ...shell })
  return { api, context }
}

describe('the list', () => {
  it('groups runs by day, newest first, with the day’s cost on its header', async () => {
    await show([
      run('r5', 'p1', 'done', { date: '2026-11-25', costYuan: 0.4, endedAt: at('2026-11-25', '08:03'), productName: '豆包·小豆' }),
      run('r4', 'p2', 'done', { date: '2026-11-25', costYuan: 0.25, endedAt: at('2026-11-25', '08:04'), productName: 'Meta Muse' }),
      run('r3', 'p1', 'done', { date: '2026-11-24', costYuan: 1.5, endedAt: at('2026-11-24', '08:05'), productName: '豆包·小豆' }),
      run('r2', 'p1', 'done', { date: '2026-11-23', costYuan: 0.1, endedAt: at('2026-11-23', '08:05'), productName: '豆包·小豆' }),
      run('r1', 'p2', 'done', { date: '2025-12-31', costYuan: 0, endedAt: at('2025-12-31', '08:05'), productName: 'Meta Muse' }),
    ])
    const days = all('.op-run-day')
    expect(days.map(day => day.querySelector('.op-run-day-title')?.textContent)).toEqual(['今天', '昨天', '11月23日', '2025年12月31日'])
    // The day's total, as an estimate, on its header; a day with no cost says none.
    expect(days.map(day => day.querySelector('.op-run-day-cost')?.textContent)).toEqual(['¥0.65（估算）', '¥1.5（估算）', '¥0.1（估算）', undefined])
    expect(days.map(day => day.querySelectorAll('.op-run').length)).toEqual([2, 1, 1, 1])
    // Within a day, the order the host sent (newest first).
    expect([...days[0]!.querySelectorAll('.op-run-object')].map(object => object.textContent)).toEqual(['豆包·小豆', 'Meta Muse'])
  })

  it('shows the kind, the object, the state, how long it took and what it cost', async () => {
    await show([
      run('r6', null, 'done', { kind: 'synthesize', startedAt: at('2026-11-25', '08:40'), endedAt: at('2026-11-25', '08:40', 20), costYuan: 0.04 }),
      run('r5', 'p1', 'done', { kind: 'verify', startedAt: at('2026-11-25', '08:20'), endedAt: at('2026-11-25', '08:21', 5), costYuan: 0.07, productName: '豆包·小豆' }),
      run('r4', 'p2', 'done', { kind: 'daily', startedAt: at('2026-11-25', '08:00'), endedAt: at('2026-11-25', '08:01', 20), costYuan: 0.123, productName: 'Meta Muse' }),
      run('r3', 'p1', 'done', { kind: 'baseline', startedAt: at('2026-11-25', '07:00'), endedAt: at('2026-11-25', '08:05'), costYuan: 2.46, productName: '豆包·小豆' }),
      run('r2', null, 'done', { kind: 'recommend', trackId: 't1', startedAt: at('2026-11-25', '06:00'), endedAt: at('2026-11-25', '06:02', 1), costYuan: 0.31 }),
      run('r1', 'p2', 'done', { kind: 'followup', startedAt: at('2026-11-25', '05:00'), endedAt: at('2026-11-25', '05:00', 9), costYuan: 0, productName: 'Meta Muse' }),
    ])
    const [synthesize, verify, daily, baseline, recommend, followup] = rows().map(cells)
    // The six kinds, in the design's words; the object is the product, the track for a recommendation, the brief for a summary.
    expect(synthesize).toMatchObject({ kind: '汇总', object: '哨报', status: '完成', time: '20 秒', cost: '¥0.04（估算）' })
    expect(verify).toMatchObject({ kind: '核查', object: '豆包·小豆', time: '1 分 5 秒', cost: '¥0.07（估算）' })
    expect(daily).toMatchObject({ kind: '日更', object: 'Meta Muse', time: '1 分 20 秒', cost: '¥0.12（估算）' })
    expect(baseline).toMatchObject({ kind: '建档', object: '豆包·小豆', time: '1 小时 5 分', cost: '¥2.5（估算）' })
    expect(recommend).toMatchObject({ kind: '推荐', object: 'Personal Agent', time: '2 分 1 秒', cost: '¥0.31（估算）' })
    // A run that cost nothing says so with a dash, not with ¥0.
    expect(followup).toMatchObject({ kind: '追问', object: 'Meta Muse', time: '9 秒', cost: '—' })
    // Every figure is an estimate and the page says so once more at the top.
    expect(text()).toContain('花费都是估算')
  })

  it('says it has nothing yet, and what went wrong when it cannot read the runs', async () => {
    await show([])
    expect(text()).toContain('还没有运行记录')
    expect(rows()).toHaveLength(0)
    unmount()
    await show(fail(500, '前哨内部出错，详情见 DSH 日志'))
    expect(document.querySelector('.op-day-problem')?.textContent).toBe('前哨内部出错，详情见 DSH 日志')
  })

  it('asks for the last 7 days and says so', async () => {
    const { api } = await show([run('r1', 'p1', 'done', { productName: '豆包·小豆' })])
    expect(api.requests.find(request => request.path === 'runs')!.query).toEqual({ days: '7' })
    expect(text()).toContain('最近 7 天')
  })
})

describe('what each state says', () => {
  it('shows a run that finished with a remark as done, with the remark in grey, not as a failure', async () => {
    await show([
      run('r3', 'p1', 'done', { error: VERIFY_BUDGET_NOTE, endedAt: at('2026-11-25', '08:05'), productName: '豆包·小豆', sessionId: 'outpost-daily-r3' }),
      run('r2', 'p2', 'done', { error: '提醒后仍没有调用 outpost_done，按已提交的内容收尾', endedAt: at('2026-11-25', '08:06'), productName: 'Meta Muse' }),
    ])
    for (const row of rows()) {
      expect(row.querySelector('.op-run-status')?.textContent).toBe('完成')
      expect(row.getAttribute('data-status')).toBe('done')
      expect(row.querySelector('.op-run-note')).not.toBeNull()
      expect(row.querySelector('.op-run-problem')).toBeNull()
      expect(inside(row, '重试')).toBeUndefined()
    }
    expect(cells(rowOf('豆包·小豆')).note).toBe('核查因预算未完成')
    expect(cells(rowOf('Meta Muse')).note).toBe('提醒后仍没有调用 outpost_done，按已提交的内容收尾')
    expect(text()).not.toContain('失败')
  })

  it('shows why a run was skipped, without calling it a failure', async () => {
    await show([run('r1', 'p1', 'skipped', { error: '今日总预算已用完', startedAt: null, productName: '豆包·小豆' })])
    expect(cells(rows()[0]!)).toMatchObject({ status: '跳过', note: '今日总预算已用完', time: '—', cost: '—' })
    expect(rows()[0]!.getAttribute('data-status')).toBe('skipped')
    expect(inside(rows()[0]!, '重试')).toBeUndefined()
  })

  it('shows why a run failed, with 重试', async () => {
    await show([run('r1', 'p1', 'failed', { error: '会话出错：模型额度不足', endedAt: at('2026-11-25', '08:02'), productName: '豆包·小豆' })])
    expect(cells(rows()[0]!)).toMatchObject({ status: '失败', note: '会话出错：模型额度不足' })
    expect(rows()[0]!.getAttribute('data-status')).toBe('failed')
    expect(inside(rows()[0]!, '重试')).toBeDefined()
  })

  it('says 被中断 for a run that Outpost’s own stop cut short, and still offers 重试', async () => {
    await show([run('r1', 'p1', 'failed', { error: STOPPED_ERROR, endedAt: at('2026-11-25', '08:02'), productName: '豆包·小豆' })])
    const [row] = rows()
    expect(cells(row!)).toMatchObject({ status: '被中断' })
    expect(row!.getAttribute('data-status')).toBe('interrupted')
    // The reason is not the bare 「前哨已停止」: it says what happened and what comes next.
    expect(cells(row!).note).toBe('前哨退出时这次还没跑完')
    expect(inside(row!, '重试')).toBeDefined()
  })

  it('sets what a run says of itself in the reading size', async () => {
    const css = (await import('../../src/client/styles.css?raw')).default
    const rule = /\.op-run-note\s*\{([^}]*)\}/.exec(css)![1]!
    expect(rule).toMatch(/font-size:\s*max\(15px,\s*var\(--dsh-content-font-size\)\)/)
    expect(rule).toMatch(/line-height:\s*1\.5\b/) // grows with the text, not a fixed 22px
  })

  it('keeps the host’s word for its stop', () => {
    // The panel must not import the host's modules; its copy equals the source (the budget note's copy is kept by today.spec.tsx).
    expect(STOPPED).toBe(STOPPED_ERROR)
  })

  it('does not offer 重试 for a follow-up, which the host cannot run again', async () => {
    await show([run('r1', 'p1', 'failed', { kind: 'followup', error: '会话打不开', endedAt: at('2026-11-25', '08:02'), productName: '豆包·小豆' })])
    expect(cells(rows()[0]!)).toMatchObject({ kind: '追问', status: '失败', note: '会话打不开' })
    expect(inside(rows()[0]!, '重试')).toBeUndefined()
  })

  it('shows a queued run as waiting, with no time yet', async () => {
    await show([run('r1', 'p1', 'queued', { startedAt: null, productName: '豆包·小豆' })])
    expect(cells(rows()[0]!)).toMatchObject({ status: '排队中', time: '—', cost: '—' })
  })

  it('counts a running run’s time live, to the second, and stops when it is over', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(new Date(at('2026-11-25', '08:03')))
    let runs: RunRow[] = [run('r1', 'p1', 'running', { startedAt: at('2026-11-25', '08:00'), productName: '豆包·小豆', sessionId: 'outpost-daily-r1' })]
    const api = stubApi({ 'GET state': shellState, 'GET runs': () => ({ runs }) })
    await mount(<Runs />, { state: shellState })
    expect(cells(rows()[0]!)).toMatchObject({ status: '运行中', time: '3 分 0 秒' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(cells(rows()[0]!).time).toBe('3 分 1 秒')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(cells(rows()[0]!).time).toBe('3 分 2 秒')
    // While a run is on, the list is read every 2 s, and the finished run shows its own time.
    runs = [{ ...runs[0]!, status: 'done', endedAt: at('2026-11-25', '08:03', 4), costYuan: 0.2 }]
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    await settle()
    expect(cells(rows()[0]!)).toMatchObject({ status: '完成', time: '3 分 4 秒', cost: '¥0.2（估算）' })
    // Nothing runs now: the list is read every 5 s, not every 2 s, and the clock stands.
    const reads = () => api.requests.filter(request => request.path === 'runs').length
    const before = reads()
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(reads()).toBe(before)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await settle()
    expect(reads()).toBe(before + 1)
  })
})

describe('opening a session', () => {
  /** A catalog that lists `ids`, and the workspace's `open`. */
  const sessionsOf = (ids: string[]) => {
    const open = vi.fn()
    const refresh = vi.fn(async () => {})
    const snapshot = { phase: 'ready', byId: Object.fromEntries(ids.map(id => [id, {}])) }
    const catalog = { list: { getSnapshot: () => snapshot, subscribe: () => () => {} }, refresh }
    return { access: { catalog, open } as unknown as NonNullable<Shell['sessions']>, open, refresh }
  }

  it('opens the run session when a row is clicked', async () => {
    const { access, open } = sessionsOf(['outpost-daily-r1'])
    await show([
      run('r2', 'p2', 'skipped', { error: '今日总预算已用完', startedAt: null, productName: 'Meta Muse' }),
      run('r1', 'p1', 'done', { endedAt: at('2026-11-25', '08:02'), productName: '豆包·小豆', sessionId: 'outpost-daily-r1' }),
    ], { sessions: access })
    const row = rowOf('豆包·小豆')
    const open1 = row.querySelector<HTMLElement>('.op-run-open')!
    expect(open1.tagName).toBe('BUTTON')
    await click(open1)
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('outpost-daily-r1')
    expect(row.querySelector('.op-run-problem')).toBeNull()
    // A run that never had a session is not a button.
    expect(rowOf('Meta Muse').querySelector('.op-run-open')?.tagName).toBe('DIV')
  })

  it('says the session is archived when DSH no longer lists it', async () => {
    const { access, open, refresh } = sessionsOf([])
    await show([run('r1', 'p1', 'done', { endedAt: at('2026-11-18', '08:02'), date: '2026-11-18', productName: '豆包·小豆', sessionId: 'outpost-daily-r1' })], { sessions: access })
    await click(rows()[0]!.querySelector<HTMLElement>('.op-run-open')!)
    expect(refresh).toHaveBeenCalled() // looked again before giving up
    expect(open).not.toHaveBeenCalled()
    expect(rows()[0]!.querySelector('.op-run-problem')?.textContent).toBe('这个会话已归档')
    expect(rows()[0]!.querySelector('.op-run-problem')?.getAttribute('role')).toBe('alert')
  })

  it('says so when the session list is not ready, or the panel has no sessions', async () => {
    const waiting = { catalog: { list: { getSnapshot: () => ({ phase: 'loading', byId: {} }), subscribe: () => () => {} }, refresh: async () => {} }, open: vi.fn() }
    await show([run('r1', 'p1', 'done', { productName: '豆包·小豆', sessionId: 'outpost-daily-r1' })], { sessions: waiting as unknown as Shell['sessions'] })
    await click(rows()[0]!.querySelector<HTMLElement>('.op-run-open')!)
    expect(rows()[0]!.querySelector('.op-run-problem')?.textContent).toBe('会话列表还没准备好，稍后再点一次')
    unmount()
    await show([run('r1', 'p1', 'done', { productName: '豆包·小豆', sessionId: 'outpost-daily-r1' })], { sessions: undefined })
    await click(rows()[0]!.querySelector<HTMLElement>('.op-run-open')!)
    expect(rows()[0]!.querySelector('.op-run-problem')?.textContent).toBe('会话列表还没准备好，稍后再点一次')
  })
})

describe('retrying', () => {
  it('retries a failed run', async () => {
    let runs: RunRow[] = [run('r1', 'p1', 'failed', { error: '会话出错：模型额度不足', endedAt: at('2026-11-25', '08:02'), productName: '豆包·小豆' })]
    const refresh = vi.fn()
    const { api } = await show(runs, { refresh }, {
      'GET runs': () => ({ runs }),
      'POST runs/:id/retry': () => {
        // The host starts the work: a new run, running now, above the failed one.
        runs = [run('r2', 'p1', 'running', { startedAt: at('2026-11-25', '08:30'), productName: '豆包·小豆' }), ...runs]
        return { runId: 'r2' }
      },
    })
    await click(inside(rows()[0]!, '重试')!)
    const retry = api.requests.find(request => request.method === 'POST')!
    expect(retry.path).toBe('runs/r1/retry')
    expect(retry.params).toEqual({ id: 'r1' })
    // The list is read again: the new run shows, running; the failed one says it was retried instead of offering 重试 again.
    expect(rows().map(row => cells(row).status)).toEqual(['运行中', '失败'])
    expect(inside(rows()[1]!, '重试')).toBeUndefined()
    expect(rows()[1]!.querySelector('.op-run-retried')?.textContent).toBe('已重试')
    // The column's numbers follow.
    expect(refresh).toHaveBeenCalled()
  })

  it('shows why a retry was refused, beside the run, and keeps 重试', async () => {
    await show([run('r1', 'p1', 'failed', { error: '会话出错', endedAt: at('2026-11-25', '08:02'), productName: '豆包·小豆' })], {},
      { 'POST runs/:id/retry': fail(409, '这个产品没有在跟踪，先恢复跟踪再更新') })
    await click(inside(rows()[0]!, '重试')!)
    expect(rows()[0]!.querySelector('.op-run-problem')?.textContent).toBe('这个产品没有在跟踪，先恢复跟踪再更新')
    expect(inside(rows()[0]!, '重试')).toBeDefined()
    // Trying again clears the message first.
    await click(inside(rows()[0]!, '重试')!)
    expect(rows()[0]!.querySelectorAll('.op-run-problem')).toHaveLength(1)
  })

  it('offers no 重试 for a run whose work ran again later that day, nor for a recommendation with a newer batch', async () => {
    await show([
      run('r6', 'p1', 'done', { productName: '豆包·小豆' }), // the scheduler's own second try went through
      run('r5', 'p1', 'failed', { error: '会话出错', productName: '豆包·小豆' }),
      run('r4', 'p2', 'failed', { kind: 'verify', error: STOPPED_ERROR, productName: 'Meta Muse' }), // the latest check: this one is to retry
      run('r3', 'p2', 'failed', { kind: 'verify', error: '模型出错', productName: 'Meta Muse' }),
      run('r2', null, 'done', { kind: 'recommend', trackId: 't1' }),
      run('r1', null, 'failed', { kind: 'recommend', trackId: 't1', error: '模型出错' }),
      run('r0', 'p1', 'failed', { date: '2026-11-24', error: '会话出错', productName: '豆包·小豆' }), // nothing ran it again that day
    ])
    expect(rows().map(row => inside(row, '重试') !== undefined)).toEqual([false, false, true, false, false, false, true])
    // It still says why it failed.
    expect(cells(rows()[1]!).note).toBe('会话出错')
  })

  it('shows the host\'s word when the work was already done again', async () => {
    await show([run('r1', 'p1', 'failed', { error: '会话出错', productName: '豆包·小豆' })], {}, { 'POST runs/:id/retry': fail(409, '已经重新跑过了') })
    await click(inside(rows()[0]!, '重试')!)
    expect(rows()[0]!.querySelector('.op-run-problem')?.textContent).toBe('已经重新跑过了')
  })

  it('does not open the session when 重试 is pressed', async () => {
    const open = vi.fn()
    await show([run('r1', 'p1', 'failed', { error: '会话出错', endedAt: at('2026-11-25', '08:02'), productName: '豆包·小豆', sessionId: 'outpost-daily-r1' })],
      { sessions: { catalog: { list: { getSnapshot: () => ({ phase: 'ready', byId: { 'outpost-daily-r1': {} } }), subscribe: () => () => {} }, refresh: async () => {} }, open } as unknown as Shell['sessions'] },
      { 'POST runs/:id/retry': { runId: 'r2' } })
    await click(inside(rows()[0]!, '重试')!)
    expect(open).not.toHaveBeenCalled()
  })
})
