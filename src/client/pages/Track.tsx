/**
 * 赛道页 (M2.1, design §5.5, mockup 5 option A), opened from the 「赛道概览」 row of a track in the middle column: the
 * track's name and what it follows; the one-sentence 格局 (AI 归纳); the 定位地图, where each product stands on two axes,
 * a dashed circle marking where it stood at the first drawing on these axes; and the 对比矩阵, one row per dimension of
 * the track and one column per product, each cell the one-line summary of that card (light blue with 「今天」 when the
 * card changed today), opening the card on the product page; it can be saved as a CSV file.
 *
 * The map and the 格局 are the model's reading of the dossiers (an inference, marked so), drawn after each day's brief
 * when a dossier changed, or here on request (「画地图」, 「重画」, 换轴). The table is the dossiers themselves.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import type { Axes, Axis, CardVersion, Dimension, Placement, Product } from '../../core/types.ts'
import type { TrackOverview } from '../../host/api.ts'
import { call, describeError, usePoll } from '../api.ts'
import { fileName, saveFile, toCsv } from '../csv.ts'
import type { T } from '../locales.ts'
import { useShell } from '../shell/context.ts'
import { localDay, shortDay } from '../time.ts'
import { ProductIcon } from '../ui/ProductIcon.tsx'
import { Tag } from '../ui/Tag.tsx'
import { labelOf } from '../words.ts'

/** How often the page reads the track again: quickly while the map is drawn, slowly otherwise (a dossier may change). */
const DRAWING_POLL_MS = 2000
const IDLE_POLL_MS = 15_000
/** Each end of an axis, as the host allows (src/host/jobs/landscape.ts `AXIS_LABEL_MAX`). */
const MAX_AXIS_LABEL = 12
/** The map's inner margin, in percent of its size: a point at an end still shows whole. */
const INSET = 9
/** A product moved this far (in -100…100 units) since the dashed circle is drawn with its circle and line. */
const MOVED = 6

const errorOf = (failure: unknown) => failure instanceof Error ? failure : new Error(String(failure))
/** Where a coordinate (-100…100) sits on the map, in percent: x from the left, y from the top (high is up). */
const left = (x: number) => INSET + (x + 100) / 200 * (100 - 2 * INSET)
const top = (y: number) => INSET + (100 - y) / 200 * (100 - 2 * INSET)

/** The newest card of each dimension of the product, by dimension. */
const cardsByDimension = (cards: CardVersion[]) => new Map(cards.map(card => [card.dimension, card]))

/** The table as rows of text (the CSV file): the dimensions down, the products across; an empty cell for a missing card. */
export function matrixRows(t: T, view: Pick<TrackOverview, 'track' | 'products'>): string[][] {
  const columns = view.products.map(item => ({ name: item.product.name, cards: cardsByDimension(item.cards) }))
  return [
    [t('track.matrix.dimension'), ...columns.map(column => column.name)],
    ...view.track.dimensions.map(dimension => [labelOf(t, dimension), ...columns.map(column => column.cards.get(dimension.key)?.summary ?? '')]),
  ]
}

export function Track(): ReactNode {
  const { t, route } = useShell()
  const trackId = route.page === 'track' ? route.trackId : ''
  const overview = usePoll(() => call('GET tracks/:id/overview', { id: trackId }), [trackId], view => view?.drawing ? DRAWING_POLL_MS : IDLE_POLL_MS)
  if (route.page !== 'track') return null
  const view = overview.data?.track.id === trackId ? overview.data : undefined
  if (!view) {
    return <div className="op-page op-track-page">
      {overview.error && <p className="op-day-problem" role="alert">{describeError(t, overview.error)}</p>}
    </div>
  }
  return <TrackPage key={view.track.id} view={view} reload={overview.reload} />
}

function TrackPage({ view, reload }: { view: TrackOverview; reload: () => Promise<void> }): ReactNode {
  const { t, state, navigate } = useShell()
  const ids = useId()
  const { track, products, landscape } = view
  const followed = products.filter(item => item.product.status === 'tracking' || item.product.status === 'paused' || item.product.status === 'baselining')
  const meta = [
    t('track.page.count', { count: followed.length }),
    t('track.page.since', { date: shortDay(track.createdAt) ?? '' }),
    ...state ? [t('track.page.daily', { time: state.runTime })] : [],
    t('track.page.dimensions', { names: track.dimensions.map(dimension => labelOf(t, dimension)).join(t('today.list')) }),
  ].join(' · ')

  return <div className="op-page op-track-page">
    <header className="op-thead">
      <div className="op-thead-titles">
        <h1 className="op-page-title">{track.name}</h1>
        <p className="op-thead-meta">{meta}</p>
        {track.brief && <p className="op-thead-brief">{track.brief}</p>}
      </div>
      <div className="op-phead-actions">
        <button type="button" className="op-button" onClick={() => { navigate({ page: 'editTrack', trackId: track.id }) }}>{t('track.page.settings')}</button>
      </div>
    </header>
    {landscape && <div className="op-gist"><Tag kind="ai" /><span>{landscape.gist}</span></div>}
    <MapSection view={view} reload={reload} titleId={`${ids}-map`} />
    <MatrixSection view={view} titleId={`${ids}-matrix`} />
  </div>
}

// ---- the map ----

function MapSection({ view, reload, titleId }: { view: TrackOverview; reload: () => Promise<void>; titleId: string }): ReactNode {
  const { t } = useShell()
  const { track, landscape, since, drawing, mappable } = view
  const [asking, setAsking] = useState(false) // 换轴 is open
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const busy = drawing || sending

  const draw = async (axes?: Axes) => {
    setSending(true)
    setProblem(null)
    try {
      await call('POST tracks/:id/map', { id: track.id, body: axes ? { axes } : {} })
      setAsking(false)
      await reload()
    } catch (failure) {
      setProblem(describeError(t, errorOf(failure)))
    } finally {
      setSending(false)
    }
  }

  const hint = since ? t('track.map.since', { date: shortDay(since.date) ?? since.date })
    : landscape ? t('track.map.drawn', { date: shortDay(landscape.createdAt) ?? landscape.date }) : null
  return <section className="op-tsection" aria-labelledby={titleId}>
    <div className="op-tsection-head">
      <h2 className="op-zone-title" id={titleId}>{t('track.map.title')}</h2>
      {landscape && <Tag kind="inference" />}
      {hint && <span className="op-tsection-hint">{hint}</span>}
      {landscape && <div className="op-tsection-actions">
        <button type="button" className="op-link" disabled={busy} aria-expanded={asking} onClick={() => { setAsking(!asking); setProblem(null) }}>{t('track.map.axes')}</button>
        <button type="button" className="op-link" disabled={busy} onClick={() => { void draw() }}>{t('track.map.redraw')}</button>
      </div>}
    </div>
    {asking && landscape && <AxesForm axes={landscape.axes} busy={busy} onSend={axes => { void draw(axes) }} onCancel={() => { setAsking(false) }} />}
    {problem && <p className="op-form-problem" role="alert">{problem}</p>}
    {drawing && <p className="op-tsection-note" role="status">{t('track.map.drawing')}</p>}
    {landscape
      ? <MapView view={view} />
      : mappable >= 2
        ? <div className="op-map-empty">
          <p className="op-zone-text">{t('track.map.none')}</p>
          <div className="op-form-actions">
            <button type="button" className="op-button" data-variant="primary" disabled={busy} aria-busy={busy || undefined}
              onClick={() => { void draw() }}>{t(busy ? 'track.map.drawingShort' : 'track.map.draw')}</button>
            <span className="op-form-hint">{t('track.map.cost')}</span>
          </div>
        </div>
        : <p className="op-zone-text">{t('track.map.needsProducts')}</p>}
  </section>
}

/** 换轴: the four ends of the two axes, as they are now; sent, the map is drawn on them and the dashed circles start again. */
function AxesForm({ axes, busy, onSend, onCancel }: { axes: Axes; busy: boolean; onSend: (axes: Axes) => void; onCancel: () => void }): ReactNode {
  const { t } = useShell()
  const ids = useId()
  const [ends, setEnds] = useState({ xLow: axes.x.low, xHigh: axes.x.high, yLow: axes.y.low, yHigh: axes.y.high })
  const filled = Object.values(ends).every(end => end.trim())
  const send = (event: FormEvent) => {
    event.preventDefault()
    if (!filled || busy) return
    onSend({ x: { low: ends.xLow.trim(), high: ends.xHigh.trim() }, y: { low: ends.yLow.trim(), high: ends.yHigh.trim() } })
  }
  const field = (key: keyof typeof ends, label: string) => <div className="op-field">
    <label htmlFor={`${ids}-${key}`}>{label}</label>
    <input id={`${ids}-${key}`} className="op-input" value={ends[key]} maxLength={MAX_AXIS_LABEL} autoComplete="off"
      onChange={event => { setEnds({ ...ends, [key]: event.target.value }) }} />
  </div>
  return <form className="op-axes-form" noValidate onSubmit={send}>
    <div className="op-axes-grid">
      {field('xLow', t('track.axes.xLow'))}{field('xHigh', t('track.axes.xHigh'))}
      {field('yLow', t('track.axes.yLow'))}{field('yHigh', t('track.axes.yHigh'))}
    </div>
    <p className="op-form-hint">{t('track.axes.hint')}</p>
    <div className="op-form-actions">
      <button type="submit" className="op-button" data-variant="primary" disabled={!filled || busy}>{t('track.axes.send')}</button>
      <button type="button" className="op-button" onClick={onCancel}>{t('track.axes.cancel')}</button>
    </div>
  </form>
}

/** Where a product stands, said in words (for a screen reader, and the point's tooltip), with why. */
function placementText(t: T, name: string, axes: Axes, p: Placement): string {
  const side = (axis: Axis, value: number) => value < -15 ? t('track.map.toward', { end: axis.low })
    : value > 15 ? t('track.map.toward', { end: axis.high }) : t('track.map.between', { low: axis.low, high: axis.high })
  const where = t('track.map.where', { name, x: side(axes.x, p.x), y: side(axes.y, p.y) })
  return p.why ? t('track.map.why', { where, why: p.why }) : where
}

function MapView({ view }: { view: TrackOverview }): ReactNode {
  const { t, navigate } = useShell()
  const landscape = view.landscape!
  const byId = new Map(view.products.map(item => [item.product.id, item.product]))
  // A product that left the track since the drawing is not shown.
  const points = landscape.positions.flatMap(p => { const product = byId.get(p.productId); return product ? [{ p, product }] : [] })
  const before = new Map((view.since?.positions ?? []).map(p => [p.productId, p]))
  const moved = points.flatMap(({ p }) => {
    const was = before.get(p.productId)
    return was && Math.hypot(was.x - p.x, was.y - p.y) >= MOVED ? [{ was, p }] : []
  })
  const { axes } = landscape
  return <div className="op-map" role="group" aria-label={t('track.map.title')}>
    <svg className="op-map-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <line x1={INSET} y1="50" x2={100 - INSET} y2="50" vectorEffect="non-scaling-stroke" />
      <line x1="50" y1={INSET} x2="50" y2={100 - INSET} vectorEffect="non-scaling-stroke" />
      {moved.map(({ was, p }) => <line key={p.productId} className="op-map-trail" x1={left(was.x)} y1={top(was.y)} x2={left(p.x)} y2={top(p.y)} vectorEffect="non-scaling-stroke" />)}
    </svg>
    <span className="op-map-axis" data-end="x-low">← {axes.x.low}</span>
    <span className="op-map-axis" data-end="x-high">{axes.x.high} →</span>
    <span className="op-map-axis" data-end="y-high">↑ {axes.y.high}</span>
    <span className="op-map-axis" data-end="y-low">↓ {axes.y.low}</span>
    {moved.map(({ was }) => <span key={`was-${was.productId}`} className="op-map-was" style={{ left: `${left(was.x)}%`, top: `${top(was.y)}%` }} aria-hidden="true" />)}
    {points.map(({ p, product }) => {
      const said = placementText(t, product.name, axes, p)
      return <button key={p.productId} type="button" className="op-map-point" style={{ left: `${left(p.x)}%`, top: `${top(p.y)}%` }}
        title={said} aria-label={said} onClick={() => { navigate({ page: 'product', productId: product.id, tab: 'dossier' }) }}>
        <ProductIcon product={product} size={20} />
        <span className="op-map-name">{product.name}</span>
      </button>
    })}
  </div>
}

// ---- the table ----

function MatrixSection({ view, titleId }: { view: TrackOverview; titleId: string }): ReactNode {
  const { t, navigate } = useShell()
  const { track, products } = view
  const today = localDay(new Date())
  const columns = products.map(item => ({ product: item.product, cards: cardsByDimension(item.cards) }))
  const open = (product: Product, dimension: Dimension) => { navigate({ page: 'product', productId: product.id, tab: 'dossier', expand: dimension.key }) }
  // Where the file went (the desktop app says), or why it could not be saved.
  const [saved, setSaved] = useState<{ ok: boolean; text: string } | null>(null)
  const save = async () => {
    const name = fileName(`${track.name}-${t('track.matrix.file')}-${today ?? ''}.csv`)
    setSaved(null)
    try {
      const path = await saveFile(name, toCsv(matrixRows(t, view)))
      if (path) setSaved({ ok: true, text: t('track.matrix.saved', { name: path.split(/[/\\]/).at(-1) ?? name }) })
    } catch (failure) {
      setSaved({ ok: false, text: t('track.matrix.saveFailed', { reason: errorOf(failure).message }) })
    }
  }
  return <section className="op-tsection" aria-labelledby={titleId}>
    <div className="op-tsection-head">
      <h2 className="op-zone-title" id={titleId}>{t('track.matrix.title')}</h2>
      <span className="op-tsection-hint">{t('track.matrix.hint')}</span>
      {products.length > 0 && <div className="op-tsection-actions">
        <button type="button" className="op-link" onClick={() => { void save() }}>{t('track.matrix.export')}</button>
      </div>}
    </div>
    {saved && <p className={saved.ok ? 'op-tsection-note' : 'op-form-problem'} role={saved.ok ? 'status' : 'alert'}>{saved.text}</p>}
    {products.length === 0
      ? <p className="op-zone-text">{t('track.matrix.empty')}</p>
      : <div className="op-matrix-wrap">
        <table className="op-matrix">
          <thead>
            <tr>
              <th scope="col" className="op-matrix-corner">{t('track.matrix.dimension')}</th>
              {columns.map(({ product }) => <th key={product.id} scope="col">
                <button type="button" className="op-matrix-product" onClick={() => { navigate({ page: 'product', productId: product.id, tab: 'dossier' }) }}>
                  <ProductIcon product={product} size={20} /><span>{product.name}</span>
                </button>
                {(product.status === 'paused' || product.status === 'baselining') && <span className="op-matrix-status">{t(`product.status.${product.status}`)}</span>}
              </th>)}
            </tr>
          </thead>
          <tbody>
            {track.dimensions.map(dimension => <tr key={dimension.key}>
              <th scope="row">{labelOf(t, dimension)}</th>
              {columns.map(({ product, cards }) => {
                const card = cards.get(dimension.key)
                const changedToday = card !== undefined && card.version > 1 && localDay(card.createdAt) === today
                return <td key={product.id} data-today={changedToday ? '' : undefined}>
                  {card
                    ? <button type="button" className="op-matrix-cell" onClick={() => { open(product, dimension) }}>
                      <span>{card.summary}</span>{changedToday && <Tag kind="today" />}
                    </button>
                    : <span className="op-matrix-none">{product.status === 'baselining' ? t('nav.baselining') : '—'}</span>}
                </td>
              })}
            </tr>)}
          </tbody>
        </table>
      </div>}
  </section>
}
