/**
 * The middle column (design §5.1, mockup 1 option B): 前哨 with 「＋ 新赛道」; 今日哨报 with its count of new findings;
 * one foldable group per track with its products (blue dot for new findings, 建档中 while baselined), 挑产品 while the
 * track is being picked and 候选推荐 while candidates wait; 运行记录 (today's spend) and 设置 pinned at the bottom.
 * M1 has no 「赛道概览 · 对比矩阵」 row (that is M2's track page).
 */
import { useState, type ReactNode } from 'react'
import type { Id } from '../../core/types.ts'
import type { TrackView } from '../../host/api.ts'
import { describeError, useCandidates } from '../api.ts'
import { BriefIcon, CheckIcon, ChevronIcon, RunsIcon, SettingsIcon, SparkleIcon, TelescopeIcon } from '../ui/icons.tsx'
import { ProductIcon } from '../ui/ProductIcon.tsx'
import { useShell } from './context.ts'
import { samePage, type Route } from './route.ts'

/** `GET state`'s polling interval while something runs (a baseline's progress, candidates arriving), and otherwise. */
export const BUSY_POLL_MS = 2000
export const IDLE_POLL_MS = 5000
const FOLDED_KEY = 'outpost.folded'

/** Yuan as the column shows them: two decimals under ¥1, one up to ¥100, whole above. */
export const yuan = (amount: number) => String(Number(amount.toFixed(amount < 1 ? 2 : amount < 100 ? 1 : 0)))

/**
 * One entry of the column: a button that shows `to`, selected (light blue, blue, bold) while that page is shown. Choosing
 * the product shown keeps its tab; choosing 今日哨报 always comes back to today's.
 */
function Row({ to, icon, label, end, endTone, dot, onChoose }: {
  to: Route; icon: ReactNode; label: string; end?: ReactNode; endTone?: 'accent'; dot?: string; onChoose?: () => void
}): ReactNode {
  const { route, navigate } = useShell()
  const current = samePage(route, to)
  return <button type="button" className="op-row" aria-current={current ? 'page' : undefined}
    onClick={() => { if (!current || to.page === 'today') navigate(to); onChoose?.() }}>
    <span className="op-row-icon">{icon}</span>
    <span className="op-row-label">{label}</span>
    {end !== undefined && <span className="op-row-end" data-tone={endTone}>{end}</span>}
    {dot && <span className="op-dot"><span className="op-visually-hidden">{dot}</span></span>}
  </button>
}

/** The tracks folded away, remembered in `localStorage` when it can be read (a convenience only). */
function useFolded(): [ReadonlySet<Id>, (id: Id) => void] {
  const [folded, setFolded] = useState<ReadonlySet<Id>>(() => {
    try {
      const stored = JSON.parse(globalThis.localStorage.getItem(FOLDED_KEY) ?? '[]') as unknown
      return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const toggle = (id: Id) => {
    const next = new Set(folded)
    if (!next.delete(id)) next.add(id)
    setFolded(next)
    try { globalThis.localStorage.setItem(FOLDED_KEY, JSON.stringify([...next])) } catch { /* Folding is remembered when it can be. */ }
  }
  return [folded, toggle]
}

/** The 挑产品 row of a track being picked, with 「已选 n」 once the count is known. */
function PickRow({ trackId, count, onChoose }: { trackId: Id; count: number | undefined; onChoose: () => void }): ReactNode {
  const { t } = useShell()
  return <Row to={{ page: 'newTrack', trackId }} icon={<CheckIcon />} label={t('nav.pick')}
    end={count === undefined ? undefined : t('nav.picked', { count })} onChoose={onChoose} />
}

/**
 * 「已选 n」 before the 挑产品 page reports its picks (after a reload, say): the candidates the latest recommendation picked
 * by default (the strong ones; an excluded one never counts), read again as they arrive (every 2 s while the recommendation
 * runs, every 30 s after).
 */
function DefaultPickRow({ trackId, onChoose }: { trackId: Id; onChoose: () => void }): ReactNode {
  const { data } = useCandidates(trackId)
  return <PickRow trackId={trackId} count={data?.candidates.filter(c => c.selected && c.tier !== 'excluded').length} onChoose={onChoose} />
}

function TrackGroup({ view, folded, onFold, onChoose }: { view: TrackView; folded: boolean; onFold: () => void; onChoose: () => void }): ReactNode {
  const { t, picks } = useShell()
  const { track, products, candidatesToReview } = view
  const picking = track.status === 'picking'
  return <div className="op-group" role="group" aria-label={track.name}>
    <button type="button" className="op-group-head" aria-expanded={!folded} onClick={onFold}>
      <ChevronIcon />
      <span className="op-group-name">{track.name}</span>
      <span className="op-group-end">{picking ? t('nav.picking') : products.length}</span>
    </button>
    {!folded && <div className="op-group-rows">
      {picking && (picks[track.id] === undefined ? <DefaultPickRow trackId={track.id} onChoose={onChoose} />
        : <PickRow trackId={track.id} count={picks[track.id]} onChoose={onChoose} />)}
      {products.map(({ product, hasNew, progress }) => {
        const end = product.status === 'baselining'
          ? `${t('nav.baselining')}${progress ? ` ${t('nav.progress', { done: progress.done, total: progress.total })}` : ''}`
          : product.status === 'paused' ? t('nav.paused') : undefined
        return <Row key={product.id} to={{ page: 'product', productId: product.id, tab: 'dossier' }} icon={<ProductIcon product={product} size={20} />}
          label={product.name} end={end} dot={hasNew ? t('nav.new') : undefined} onChoose={onChoose} />
      })}
      {!picking && candidatesToReview > 0 && <Row to={{ page: 'newTrack', trackId: track.id }} icon={<SparkleIcon />} label={t('nav.candidates')}
        end={t('nav.candidatesWaiting', { count: candidatesToReview })} onChoose={onChoose} />}
    </div>}
  </div>
}

/** The column; `onChoose` runs after any entry is chosen (the narrow layout closes the column then). */
export function MiddleColumn({ onChoose = () => {} }: { onChoose?: () => void }): ReactNode {
  const { t, state, stateError, navigate } = useShell()
  const [folded, toggleFold] = useFolded()
  const tracks = state?.tracks ?? []
  const todayEnd = state === undefined ? undefined : state.todayUnread > 0 ? t('nav.todayNew', { count: state.todayUnread })
    : tracks.length === 0 ? t('nav.todayNone') : undefined
  return <nav className="op-mid" aria-label={t('nav.label')}>
    <div className="op-mid-head">
      <TelescopeIcon size={20} />
      <h2 className="op-mid-title">{t('panel')}</h2>
      <button type="button" className="op-new-track" onClick={() => { navigate({ page: 'newTrack' }); onChoose() }}>{t('nav.newTrack')}</button>
    </div>
    {stateError && <p className="op-mid-note" role="status">{describeError(t, stateError)}</p>}
    <Row to={{ page: 'today' }} icon={<BriefIcon />} label={t('nav.today')} end={todayEnd}
      endTone={state && state.todayUnread > 0 ? 'accent' : undefined} onChoose={onChoose} />
    <div className="op-mid-tracks">
      {tracks.map(view => <TrackGroup key={view.track.id} view={view} folded={folded.has(view.track.id)}
        onFold={() => { toggleFold(view.track.id) }} onChoose={onChoose} />)}
    </div>
    <div className="op-mid-foot">
      <Row to={{ page: 'runs' }} icon={<RunsIcon />} label={t('nav.runs')}
        end={state && state.todayCostYuan >= 0.01 ? t('nav.todayCost', { amount: yuan(state.todayCostYuan) }) : undefined} onChoose={onChoose} />
      <Row to={{ page: 'settings' }} icon={<SettingsIcon />} label={t('nav.settings')} onChoose={onChoose} />
    </div>
  </nav>
}
