/**
 * The middle column (design §5.1, mockup 1 option B): 前哨 with 「＋ 新赛道」; 今日哨报 with its count of new findings;
 * one foldable group per track with its products (blue dot for new findings, 建档中 while baselined) and 「＋ 添加产品」,
 * 挑产品 while the track is being picked and 候选推荐 while candidates wait; 运行记录 (today's spend) and 设置 pinned at the bottom.
 * Each track that is on starts with 「赛道概览」, its page with the 定位地图 and the 对比矩阵 (M2.1); the 「⋯」 beside a
 * track's name opens its settings (M1.5). Tracks, and the products within a track, are put in order by dragging them, or
 * with Alt+↑/↓ on one that has the focus (M2.4); a product moves to another track from its page's 「⋯」, not by dragging.
 */
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { Id } from '../../core/types.ts'
import type { TrackView } from '../../host/api.ts'
import { call, describeError, useCandidates } from '../api.ts'
import { BriefIcon, CheckIcon, ChevronIcon, OverviewIcon, RunsIcon, SearchIcon, SettingsIcon, SparkleIcon, TelescopeIcon } from '../ui/icons.tsx'
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
function Row({ to, icon, label, end, endTone, dot, quiet, onChoose, drag }: {
  to: Route; icon: ReactNode; label: string; end?: ReactNode; endTone?: 'accent'; dot?: string; quiet?: boolean; onChoose?: () => void
  /** What makes it movable (a product among its track's): the drag and keyboard handlers, and where a drop would land. */
  drag?: DragProps
}): ReactNode {
  const { route, navigate } = useShell()
  const current = samePage(route, to)
  return <button type="button" className="op-row" data-quiet={quiet ? '' : undefined} aria-current={current ? 'page' : undefined}
    {...drag} onClick={() => { if (!current || to.page === 'today') navigate(to); onChoose?.() }}>
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
 * by default (the strong ones; an excluded one never counts, nor one whose product is in the track already, put there by
 * 也加到: the page does not count it either), read again as they arrive (every 2 s while the recommendation runs, every
 * 30 s after).
 */
function DefaultPickRow({ trackId, tracked, onChoose }: { trackId: Id; tracked: ReadonlySet<Id>; onChoose: () => void }): ReactNode {
  const { data } = useCandidates(trackId)
  const count = data?.candidates.filter(c => c.selected && c.tier !== 'excluded' && !tracked.has(c.productId)).length
  return <PickRow trackId={trackId} count={count} onChoose={onChoose} />
}

/** The handlers that let an entry be dragged and dropped among its kind, and moved with Alt+↑/↓. */
type DragProps = {
  draggable: true
  'data-drop'?: 'before' | 'after'
  'data-reorder': string
  'aria-keyshortcuts': string
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDragLeave: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onDragEnd: () => void
  onKeyDown: (event: KeyboardEvent) => void
}

/** The drag's own data type: dropped on a text field (DSH's chat input, say), a row inserts nothing. */
const DRAG_TYPE = 'application/x-outpost-reorder'
/** What is being dragged, across the lists (a drag starts in one list's hook and may pass over another's). */
let dragged: { group: string; id: Id } | null = null

/** Where over `target` a drop at `clientY` lands: before it in its upper half, after it in its lower. */
const sideOf = (target: Element, clientY: number): 'before' | 'after' => {
  const box = target.getBoundingClientRect()
  return clientY < box.top + box.height / 2 ? 'before' : 'after'
}

/**
 * Putting a list in order (M2.4): `ids` as the host lists them, and what saves a new order. The new order shows at once
 * (`order`, until the host's next answer), so quick moves build on each other; an entry dragged over another lands before
 * it (upper half) or after it (lower half); Alt+↑/↓ moves the focused one a place and keeps the focus on it. Only entries
 * of the same list (`group`) take a drop: a product does not land among another track's.
 */
function useReorder(group: string, ids: readonly Id[], save: (order: Id[]) => void) {
  const [pending, setPending] = useState<readonly Id[] | null>(null)
  const [over, setOver] = useState<{ id: Id; side: 'before' | 'after' } | null>(null)
  const [focusId, setFocusId] = useState<Id | null>(null)
  const key = ids.join(' ')
  // The host's answer is the order now.
  useEffect(() => { setPending(null) }, [key])
  const order = pending && pending.length === ids.length && pending.every(id => ids.includes(id)) ? pending : ids
  // A moved entry's node moves too, and the browser drops its focus: give it back.
  useEffect(() => {
    if (focusId === null) return
    const element = document.querySelector<HTMLElement>(`[data-reorder="${group}:${focusId}"]`)
    const target = element?.matches('button') ? element : element?.querySelector<HTMLElement>('button')
    target?.focus()
    setFocusId(null)
  }, [focusId, group, order])
  const place = (id: Id, target: Id, side: 'before' | 'after') => {
    if (id === target) return
    const rest = order.filter(other => other !== id)
    const at = rest.indexOf(target) + (side === 'after' ? 1 : 0)
    const next = [...rest.slice(0, at), id, ...rest.slice(at)]
    if (next.join(' ') === order.join(' ')) return
    setPending(next)
    save(next)
  }
  const ours = () => dragged !== null && dragged.group === group
  const props = (id: Id): DragProps => ({
    draggable: true,
    ...over?.id === id ? { 'data-drop': over.side } : {},
    'data-reorder': `${group}:${id}`,
    'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown',
    onDragStart: event => {
      event.stopPropagation() // a product's row is inside its track's group: the track does not move with it
      dragged = { group, id }
      try { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(DRAG_TYPE, id) } catch { /* no data transfer here */ }
    },
    onDragOver: event => {
      if (!ours() || dragged!.id === id) return
      event.preventDefault()
      event.stopPropagation()
      const side = sideOf(event.currentTarget, event.clientY)
      if (over?.id !== id || over.side !== side) setOver({ id, side })
    },
    onDragLeave: event => {
      // Leaving the row for its own icon or label is still over it.
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
      if (over?.id === id) setOver(null)
    },
    onDrop: event => {
      if (!ours()) return
      event.preventDefault()
      event.stopPropagation()
      const from = dragged!
      dragged = null
      setOver(null)
      place(from.id, id, sideOf(event.currentTarget, event.clientY))
    },
    onDragEnd: () => { dragged = null; setOver(null) },
    onKeyDown: event => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
      event.preventDefault()
      event.stopPropagation()
      const at = order.indexOf(id)
      const to = event.key === 'ArrowUp' ? at - 1 : at + 1
      if (at < 0 || to < 0 || to >= order.length) return
      place(id, order[to]!, event.key === 'ArrowUp' ? 'before' : 'after')
      setFocusId(id)
    },
  })
  return { order, props }
}

function TrackGroup({ view, folded, onFold, onChoose, move }: { view: TrackView; folded: boolean; onFold: () => void; onChoose: () => void; move: DragProps }): ReactNode {
  const { t, picks, route, navigate } = useShell()
  const { track, products, candidatesToReview } = view
  const picking = track.status === 'picking'
  const editing = route.page === 'editTrack' && route.trackId === track.id
  const { refresh } = useShell()
  const reorder = useReorder(`products:${track.id}`, products.map(item => item.product.id), order => {
    call('POST tracks/:id/reorder', { id: track.id, body: { productIds: order } }).then(() => { refresh() }, () => { refresh() })
  })
  const byId = new Map(products.map(item => [item.product.id, item]))
  const ordered = reorder.order.flatMap(id => byId.get(id) ?? [])
  return <div className="op-group" role="group" aria-label={track.name}>
    <div className="op-group-top" {...move} title={t('nav.reorder')}>
      <button type="button" className="op-group-head" aria-expanded={!folded} onClick={onFold}>
        <ChevronIcon />
        <span className="op-group-name">{track.name}</span>
        <span className="op-group-end">{picking ? t('nav.picking') : products.length}</span>
      </button>
      {/* The track's own page: its name, what it follows, its dimensions, and deleting it (M1.5). */}
      <button type="button" className="op-group-more" title={t('nav.trackSettings', { track: track.name })} aria-label={t('nav.trackSettings', { track: track.name })}
        aria-current={editing ? 'page' : undefined} onClick={() => { if (!editing) navigate({ page: 'editTrack', trackId: track.id }); onChoose() }}>⋯</button>
    </div>
    {!folded && <div className="op-group-rows">
      {!picking && <Row to={{ page: 'track', trackId: track.id }} icon={<OverviewIcon />} label={t('nav.overview')} onChoose={onChoose} />}
      {picking && (picks[track.id] === undefined ? <DefaultPickRow trackId={track.id} tracked={new Set(products.map(item => item.product.id))} onChoose={onChoose} />
        : <PickRow trackId={track.id} count={picks[track.id]} onChoose={onChoose} />)}
      {ordered.map(({ product, hasNew, progress }) => {
        const end = product.status === 'baselining'
          ? `${t('nav.baselining')}${progress ? ` ${t('nav.progress', { done: progress.done, total: progress.total })}` : ''}`
          : product.status === 'paused' ? t('nav.paused') : undefined
        return <Row key={product.id} to={{ page: 'product', productId: product.id, tab: 'dossier' }} icon={<ProductIcon product={product} size={20} />}
          label={product.name} end={end} dot={hasNew ? t('nav.new') : undefined} onChoose={onChoose} drag={reorder.props(product.id)} />
      })}
      {/* A track still being picked has no products to add to yet: its 挑产品 page is where they come from. */}
      {!picking && <Row to={{ page: 'addProduct', trackId: track.id }} icon={null} label={t('add.row')} quiet onChoose={onChoose} />}
      {!picking && candidatesToReview > 0 && <Row to={{ page: 'newTrack', trackId: track.id }} icon={<SparkleIcon />} label={t('nav.candidates')}
        end={t('nav.candidatesWaiting', { count: candidatesToReview })} onChoose={onChoose} />}
    </div>}
  </div>
}

/** How long typing pauses before the results follow (M3.2). */
export const SEARCH_DEBOUNCE_MS = 250

/**
 * The search box (M3.2): what is typed shows on the search page once typing pauses (Enter at once, and the narrow layout
 * closes the column then); Esc empties it. It shows the search page's words while that page is open, and is emptied when
 * another page opens.
 */
function SearchBox({ onChoose }: { onChoose: () => void }): ReactNode {
  const { t, route, navigate } = useShell()
  const onSearch = route.page === 'search'
  const [text, setText] = useState(onSearch ? route.q : '')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Another page opened (a row chosen while a search was still due, say): nothing due any more, and the box empties.
  useEffect(() => { if (route.page !== 'search') { clearTimeout(timer.current); setText('') } }, [route])
  useEffect(() => () => { clearTimeout(timer.current) }, [])
  /** Shows the results for `value`; as one types (`keepColumn`) the narrow layout's column stays open. */
  const go = (value: string, keepColumn: boolean) => { clearTimeout(timer.current); navigate({ page: 'search', q: value.trim() }, { keepColumn }) }
  const later = (value: string) => {
    clearTimeout(timer.current)
    if (value.trim() || onSearch) timer.current = setTimeout(() => { go(value, true) }, SEARCH_DEBOUNCE_MS)
  }
  return <div className="op-mid-search" role="search">
    <SearchIcon size={16} />
    <input type="search" className="op-mid-search-input" placeholder={t('search.placeholder')} aria-label={t('search.label')} value={text} maxLength={60}
      onChange={event => {
        const value = event.target.value
        setText(value)
        // While an input method composes (pinyin being chosen), nothing is searched: the words are not there yet.
        if ((event.nativeEvent as InputEvent).isComposing) clearTimeout(timer.current)
        else later(value)
      }}
      onCompositionEnd={event => { later(event.currentTarget.value) }}
      onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); go(text, false); onChoose() }
        else if (event.key === 'Escape' && text) {
          event.preventDefault()
          event.stopPropagation()
          clearTimeout(timer.current)
          setText('')
          if (onSearch) go('', true)
        }
      }} />
  </div>
}

/** The column; `onChoose` runs after any entry is chosen (the narrow layout closes the column then). */
export function MiddleColumn({ onChoose = () => {} }: { onChoose?: () => void }): ReactNode {
  const { t, state, stateError, navigate, refresh } = useShell()
  const [folded, toggleFold] = useFolded()
  const tracks = state?.tracks ?? []
  const reorder = useReorder('tracks', tracks.map(view => view.track.id), order => {
    call('POST tracks/reorder', { body: { trackIds: order } }).then(() => { refresh() }, () => { refresh() })
  })
  const byTrack = new Map(tracks.map(view => [view.track.id, view]))
  const todayEnd = state === undefined ? undefined : state.todayUnread > 0 ? t('nav.todayNew', { count: state.todayUnread })
    : tracks.length === 0 ? t('nav.todayNone') : undefined
  return <nav className="op-mid" aria-label={t('nav.label')}>
    <div className="op-mid-head">
      <TelescopeIcon size={20} />
      <h2 className="op-mid-title">{t('panel')}</h2>
      <button type="button" className="op-new-track" onClick={() => { navigate({ page: 'newTrack' }); onChoose() }}>{t('nav.newTrack')}</button>
    </div>
    <SearchBox onChoose={onChoose} />
    {stateError && <p className="op-mid-note" role="status">{describeError(t, stateError)}</p>}
    <Row to={{ page: 'today' }} icon={<BriefIcon />} label={t('nav.today')} end={todayEnd}
      endTone={state && state.todayUnread > 0 ? 'accent' : undefined} onChoose={onChoose} />
    <div className="op-mid-tracks">
      {reorder.order.flatMap(id => byTrack.get(id) ?? []).map(view => <TrackGroup key={view.track.id} view={view} folded={folded.has(view.track.id)} move={reorder.props(view.track.id)}
        onFold={() => { toggleFold(view.track.id) }} onChoose={onChoose} />)}
    </div>
    <div className="op-mid-foot">
      <Row to={{ page: 'runs' }} icon={<RunsIcon />} label={t('nav.runs')}
        end={state && state.todayCostYuan >= 0.01 ? t('nav.todayCost', { amount: yuan(state.todayCostYuan) }) : undefined} onChoose={onChoose} />
      <Row to={{ page: 'settings' }} icon={<SettingsIcon />} label={t('nav.settings')} onChoose={onChoose} />
    </div>
  </nav>
}
