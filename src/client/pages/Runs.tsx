/**
 * 运行记录 (design §5.7): every research session of the last 7 days, grouped by day (newest first, the day's cost on its
 * header). A row says the kind, the subject, how it stands, how long it took and what it cost (an estimate). A row with a
 * session opens it in DSH; a failed one says why and can be retried, unless its work ran again later (`redoneRuns`). The
 * list is read every 5 s, every 2 s while a run is queued or running, and a running run's time counts up on its own every
 * second.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Product } from '../../core/types.ts'
import type { RunRow } from '../../host/api.ts'
import { call, describeError, usePoll } from '../api.ts'
import type { T } from '../locales.ts'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { STOPPED } from '../notes.ts'
import { useShell } from '../shell/context.ts'
import { yuan } from '../shell/MiddleColumn.tsx'
import { duration, localDay } from '../time.ts'
import { ProductIcon } from '../ui/ProductIcon.tsx'
import { told } from '../words.ts'

const POLL_MS = 5000
const BUSY_MS = 2000
/** How far back the list goes (`GET runs?days=`); the page's header says so. */
const WINDOW_DAYS = 7

const isActive = (run: RunRow) => run.status === 'queued' || run.status === 'running'

/** What a run did, for telling whether it was done again: a daily update or check of one product on one day, or a track's recommendation. */
function workOf(run: RunRow): string | null {
  if (run.kind === 'recommend') return run.trackId === null ? null : `recommend ${run.trackId}`
  if ((run.kind === 'daily' || run.kind === 'verify') && run.productId !== null) return `${run.kind} ${run.productId} ${run.date}`
  return null
}

/**
 * The runs whose work ran again later, so that 重试 would pay for it twice: a later run of the same kind for the same
 * product on the same day (the host tries a failed product once more and resumes an interrupted one), or a newer batch of
 * the same track. `runs` come newest first, as the host lists them. The host refuses such a retry too (「已经重新跑过了」).
 */
function redoneRuns(runs: readonly RunRow[]): Set<string> {
  const seen = new Set<string>()
  const redone = new Set<string>()
  for (const run of runs) {
    const work = workOf(run)
    if (work === null) continue
    if (seen.has(work)) redone.add(run.id)
    else seen.add(work)
  }
  return redone
}
const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))

/** How a run stands in the reader's words: a run that failed only because Outpost quit is 被中断, not a failure. */
type Shown = 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'skipped'
const shownOf = (run: RunRow): Shown => run.status === 'failed' && run.error === STOPPED ? 'interrupted' : run.status

/** The clock of a running run: `Date.now()`, read again every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [active])
  return now
}

/** The local date `days` days after `date` (`YYYY-MM-DD`). */
function shiftDay(date: string, days: number): string {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/** 「今天」, 「昨天」, 「11月23日」, or with the year for another year than today's. */
function dayLabel(t: T, date: string, today: string): string {
  if (date === today) return t('runs.today')
  if (date === shiftDay(today, -1)) return t('runs.yesterday')
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number)
  return date.slice(0, 4) === today.slice(0, 4) ? t('runs.day', { month, day }) : t('runs.dayYear', { year, month, day })
}

const costText = (t: T, cost: number) => t('runs.cost', { amount: yuan(Math.max(cost, 0.01)) })

function RunItem({ run, now, trackName, product, redone, reload }: {
  run: RunRow; now: number; trackName: string | undefined; product: Product | undefined; redone: boolean; reload: () => Promise<void>
}): ReactNode {
  const { t, sessions, refresh } = useShell()
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState<'open' | 'retry' | null>(null)
  const [retried, setRetried] = useState(false)
  const opening = useRef<AbortController | null>(null)
  useEffect(() => () => { opening.current?.abort() }, [])

  const shown = shownOf(run)
  // A confirmation names the product it confirmed once there is one, before that what the user typed.
  // A deleted product or track is named as it was when it was deleted (the host keeps that name in `subject`).
  const gone = (name: string | null) => name === null ? null : t('runs.deleted', { name })
  const object = run.kind === 'synthesize' ? t('runs.object.brief') : run.kind === 'recommend' || run.kind === 'landscape' ? trackName ?? gone(run.subject)
    : run.kind === 'topic' || run.kind === 'topicCheck' ? run.subject // the 专题's question (M2.3)
    : run.productName ?? (run.productId !== null ? gone(run.subject) : run.subject)
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN
  const ended = run.endedAt ? Date.parse(run.endedAt) : run.status === 'running' ? now : NaN
  const took = Number.isFinite(started) && Number.isFinite(ended) ? duration(t, (ended - started) / 1000) : t('runs.none')
  // What the run says about itself: a remark on one that finished, the reason of one that was skipped or failed.
  const note = shown === 'done' ? run.error && told(t, run.error) : shown === 'skipped' || shown === 'failed' ? (run.error ? told(t, run.error) : t('runs.noReason'))
    : shown === 'interrupted' ? t('runs.interrupted') : null
  // A follow-up is a chat the reader started, which the host cannot run again; a confirmation is asked for again from
  // 「＋ 添加产品」.
  // A 专题's round is run again from its page (立即更新): a retry would not know which version it builds on.
  const retryable = (shown === 'failed' || shown === 'interrupted') && run.kind !== 'followup' && run.kind !== 'identify' && run.kind !== 'topic' && run.kind !== 'topicCheck'

  const open = async () => {
    if (!run.sessionId) return
    opening.current?.abort()
    const controller = new AbortController()
    opening.current = controller
    setProblem(null)
    setBusy('open')
    try {
      if (!sessions) throw new SessionNavigationError('not-ready')
      await openKnownSession(sessions.catalog, run.sessionId as SessionId, sessions.open, controller.signal)
    } catch (error) {
      setProblem(error instanceof SessionNavigationError ? t(error.code === 'not-ready' ? 'runs.sessionNotReady' : 'runs.archived') : describeError(t, errorOf(error)))
    } finally {
      setBusy(null)
    }
  }
  const retry = async () => {
    setProblem(null)
    setBusy('retry')
    try {
      await call('POST runs/:id/retry', { id: run.id })
      setRetried(true)
      await reload()
      refresh()
    } catch (error) {
      setProblem(describeError(t, errorOf(error)))
    } finally {
      setBusy(null)
    }
  }

  const cells = <>
    <span className="op-run-kind">{t(`runs.kind.${run.kind}`)}</span>
    <span className="op-run-subject">
      {product && <ProductIcon product={product} size={18} />}
      <span className="op-run-object">{object || t('runs.none')}</span>
    </span>
    <span className="op-run-status" data-status={shown}>{t(`runs.status.${shown}`)}</span>
    <span className="op-run-figures">
      <span className="op-run-time">{took}</span>
      <span className="op-run-cost" title={run.usage.searches ? t('runs.searches', { count: run.usage.searches }) : undefined}>
        {run.costYuan > 0 ? costText(t, run.costYuan) : t('runs.none')}
      </span>
    </span>
  </>
  return <li className="op-run" data-status={shown} data-kind={run.kind}>
    <div className="op-run-line">
      {run.sessionId
        ? <button type="button" className="op-run-open" title={t('runs.open')} aria-busy={busy === 'open' || undefined} onClick={() => { void open() }}>{cells}</button>
        : <div className="op-run-open">{cells}</div>}
      <div className="op-run-act">
        {retryable && (retried ? <span className="op-run-retried">{t('runs.retried')}</span>
          : !redone && <button type="button" className="op-button" data-size="small" disabled={busy === 'retry'} aria-busy={busy === 'retry' || undefined}
            onClick={() => { void retry() }}>{t(busy === 'retry' ? 'runs.retrying' : 'runs.retry')}</button>)}
      </div>
    </div>
    {note && <p className="op-run-note">{note}</p>}
    {problem && <p className="op-run-problem" role="alert">{problem}</p>}
  </li>
}

export function Runs(): ReactNode {
  const { t, state } = useShell()
  const { data, error, reload } = usePoll(() => call('GET runs', { query: { days: WINDOW_DAYS } }), [],
    latest => latest?.runs.some(isActive) ? BUSY_MS : POLL_MS)
  const runs = data?.runs
  const now = useNow(runs?.some(run => run.status === 'running') ?? false)

  const days = useMemo(() => {
    const byDay = new Map<string, RunRow[]>()
    for (const run of runs ?? []) byDay.set(run.date, [...byDay.get(run.date) ?? [], run])
    return [...byDay].sort(([a], [b]) => a < b ? 1 : a > b ? -1 : 0)
  }, [runs])
  const redone = useMemo(() => redoneRuns(runs ?? []), [runs])
  const today = state?.todayDate ?? localDay(new Date(now)) ?? ''
  const tracks = new Map(state?.tracks.map(view => [view.track.id, view.track.name] as const))
  const products = new Map(state?.tracks.flatMap(view => view.products.map(item => [item.product.id, item.product] as const)))

  return <div className="op-page op-runs">
    <header className="op-runs-head">
      <h1 className="op-page-title">{t('nav.runs')}</h1>
      {runs && runs.length > 0 && <p className="op-day-meta">{t('runs.meta', { count: runs.length })}</p>}
    </header>
    {!runs && error && <p className="op-day-problem" role="status">{describeError(t, error)}</p>}
    {runs?.length === 0 && <p className="op-day-empty">{t('runs.empty')}</p>}
    {days.length > 0 && <div className="op-runs-cols" aria-hidden="true">
      <span>{t('runs.col.kind')}</span><span>{t('runs.col.object')}</span><span>{t('runs.col.status')}</span><span>{t('runs.col.time')}</span><span>{t('runs.col.cost')}</span>
    </div>}
    {days.map(([date, dayRuns]) => {
      const cost = dayRuns.reduce((sum, run) => sum + run.costYuan, 0)
      return <section key={date} className="op-run-day">
        <header className="op-run-day-head">
          <h2 className="op-run-day-title">{dayLabel(t, date, today)}</h2>
          {cost > 0 && <span className="op-run-day-cost">{costText(t, cost)}</span>}
        </header>
        <ul className="op-run-list" aria-label={t('runs.list')}>
          {dayRuns.map(run => <RunItem key={run.id} run={run} now={now} reload={reload} redone={redone.has(run.id)}
            trackName={run.trackId ? tracks.get(run.trackId) : undefined} product={run.productId ? products.get(run.productId) : undefined} />)}
        </ul>
      </section>
    })}
  </div>
}
