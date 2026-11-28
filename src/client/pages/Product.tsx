/**
 * 产品档案 (design §5.4, mockup 4 option A): the page of one product. The header (icon, name, status, company · when it
 * was profiled · when it last changed, and the actions), the tabs 档案 / 动态 / 来源, and the tab's page. The profile is
 * read every 5 s (2 s while it is being built or updated), so a card the baseline just wrote, or the update the reader
 * asked for, shows up by itself.
 */
import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { DimensionKey, Id } from '../../core/types.ts'
import { call, describeError, usePoll } from '../api.ts'
import { useShell } from '../shell/context.ts'
import type { ProductTab, Route } from '../shell/route.ts'
import { clockTime, localDay, shortDay } from '../time.ts'
import { ProductIcon } from '../ui/ProductIcon.tsx'
import { DossierTab, shownCards } from './product/DossierTab.tsx'
import { FeedTab } from './product/FeedTab.tsx'
import { ProductMenu, type ProductChange, type ProductTracks, type TrackChange } from './product/ProductMenu.tsx'
import { citations, SourcesTab } from './product/SourcesTab.tsx'
import { told } from '../words.ts'

/** How often the profile is read, and how often while something works on it; and how often a run is asked about. */
const POLL_MS = 5000
const BUSY_MS = 2000
const RUN_MS = 2000
const TABS: readonly ProductTab[] = ['dossier', 'feed', 'sources']

type ProductRoute = Extract<Route, { page: 'product' }>

const errorOf = (error: unknown) => error instanceof Error ? error : new Error(String(error))

export function Product(): ReactNode {
  const { route } = useShell()
  // Another product is another page: nothing of the last one stays.
  return route.page === 'product' ? <ProductPage key={route.productId} route={route} /> : null
}

function ProductPage({ route }: { route: ProductRoute }): ReactNode {
  const { t, navigate, state, refresh } = useShell()
  const { productId, tab, expand } = route
  const ids = useId()

  const [runId, setRunId] = useState<Id | null>(null)
  const [starting, setStarting] = useState(false)
  const [updateNote, setUpdateNote] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<DimensionKey>>(() => new Set(expand ? [expand] : []))
  useEffect(() => { if (expand) setExpanded(previous => previous.has(expand) ? previous : new Set(previous).add(expand)) }, [expand])

  const profile = usePoll(() => call('GET products/:id', { id: productId }), [productId],
    latest => runId !== null || latest?.product.status === 'baselining' || latest?.progress ? BUSY_MS : POLL_MS)
  const feed = usePoll(() => call('GET products/:id/findings', { id: productId }), [productId], POLL_MS)
  const view = profile.data
  const { reload: reloadProfile } = profile
  const { reload: reloadFeed } = feed

  // 立即更新: the run the host started is asked about until it is over; then the profile and the column are read again.
  useEffect(() => {
    if (runId === null) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      let found
      try {
        found = (await call('GET runs', { query: { days: 2 } })).runs.find(run => run.id === runId)
      } catch {
        if (active) timer = setTimeout(() => { void check() }, RUN_MS)
        return
      }
      if (!active) return
      if (found && (found.status === 'queued' || found.status === 'running')) { timer = setTimeout(() => { void check() }, RUN_MS); return }
      setRunId(null)
      if (found?.status === 'failed') setUpdateNote(t('product.updateFailed', { reason: found.error ? told(t, found.error) : t('product.updateUnknown') }))
      else if (found?.status === 'skipped') setUpdateNote(t('product.updateSkipped', { reason: found.error ? told(t, found.error) : t('product.updateUnknown') }))
      void reloadProfile()
      void reloadFeed()
      refresh()
    }
    void check()
    return () => { active = false; clearTimeout(timer) }
  }, [runId, reloadProfile, reloadFeed, refresh, t])

  const startUpdate = async () => {
    setUpdateNote(null)
    setStarting(true)
    try {
      setRunId((await call('POST products/:id/update-now', { id: productId })).runId)
    } catch (error) {
      setUpdateNote(describeError(t, errorOf(error)))
    } finally {
      setStarting(false)
    }
  }
  const change = async (body: ProductChange) => {
    await call('PATCH products/:id', { id: productId, body })
    await reloadProfile()
    refresh()
  }

  // Moving, adding and taking out: the answer is how many cards were asked for. The page and the column are read again.
  const changeTracks = async (body: TrackChange) => {
    const toppedUp = body.kind === 'move' ? (await call('POST products/:id/move', { id: productId, body: { from: body.from, to: body.to } })).toppedUp
      : body.kind === 'link' ? (await call('POST products/:id/link', { id: productId, body: { trackId: body.to } })).toppedUp
      : (await call('POST products/:id/unlink', { id: productId, body: { trackId: body.from } }), 0)
    await reloadProfile()
    refresh()
    return toppedUp
  }

  const known = state?.tracks.flatMap(entry => entry.products).find(item => item.product.id === productId)?.product
  const product = view?.product ?? known
  const updating = starting || runId !== null || !!view?.progress
  // The tracks the product is in (the state lists no archived one), and the others it could go to; unknown until the state is read.
  const inTracks = state?.tracks.filter(entry => entry.products.some(item => item.product.id === productId)).map(entry => entry.track) ?? []
  const tracks: ProductTracks | null = state && inTracks.length > 0 ? {
    current: inTracks.map(({ id, name }) => ({ id, name })),
    others: state.tracks.map(entry => entry.track).filter(track => track.status !== 'archived' && !inTracks.some(own => own.id === track.id)).map(({ id, name }) => ({ id, name })),
  } : null

  // Which cards can be opened (those on the page that exist), and whether they all are.
  const shown = view ? shownCards(view) : []
  const openable = shown.map(card => card.dimension)
  const allOpen = openable.length > 0 && openable.every(key => expanded.has(key))
  const toggle = (key: DimensionKey) => setExpanded(previous => { const next = new Set(previous); if (!next.delete(key)) next.add(key); return next })

  const now = new Date()
  const times = view ? [...Object.values(view.history).flat(), ...view.cards].map(version => Date.parse(version.createdAt)).filter(Number.isFinite) : []
  // When it was last updated is told by the cards on the page; the times above include those kept out of sight.
  const newest = shown.length > 0 ? Math.max(...shown.map(card => Date.parse(card.createdAt)).filter(Number.isFinite)) : NaN
  const sameDay = Number.isFinite(newest) && localDay(new Date(newest)) === localDay(now)
  const meta = [
    product?.company,
    times.length > 0 && t('product.founded', { date: shortDay(new Date(Math.min(...times)).toISOString(), now) ?? '' }),
    Number.isFinite(newest) && t('product.updated', { when: sameDay ? `${t('product.today')} ${clockTime(new Date(newest).toISOString()) ?? ''}` : shortDay(new Date(newest).toISOString(), now) ?? '' }),
  ].filter(Boolean).join(' · ')

  // The sources the 来源 tab lists: those a card on the page cites.
  const listedSources = view ? citations(view).sources.length : 0
  const unproven = feed.data?.findings.filter(finding => finding.status === 'unproven').length ?? 0
  const feedCount = feed.data ? feed.data.findings.length - unproven : 0
  const go = (next: ProductTab) => { if (next !== tab) navigate({ page: 'product', productId, tab: next }) }
  const onTabKey = (event: KeyboardEvent) => {
    const at = TABS.indexOf(tab)
    const to = event.key === 'ArrowRight' ? TABS[(at + 1) % TABS.length] : event.key === 'ArrowLeft' ? TABS[(at + TABS.length - 1) % TABS.length]
      : event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS[TABS.length - 1] : undefined
    if (!to) return
    event.preventDefault()
    go(to)
    document.getElementById(`${ids}-${to}`)?.focus()
  }

  return <div className="op-page op-product">
    <header className="op-phead">
      {product && <ProductIcon product={product} size={44} />}
      <div className="op-phead-titles">
        <div className="op-phead-line">
          <h1 className="op-phead-name">{product?.name ?? t('page.product')}</h1>
          {product && (product.status === 'tracking' || product.status === 'paused' || product.status === 'baselining')
            && <span className="op-status" data-status={product.status}>{t(`product.status.${product.status}`)}</span>}
        </div>
        {meta && <p className="op-phead-meta">{meta}</p>}
      </div>
      {view && <div className="op-phead-actions">
        {tab === 'dossier' && openable.length > 0 && <button type="button" className="op-button" data-size="small"
          onClick={() => { setExpanded(allOpen ? new Set() : new Set(openable)) }}>{t(allOpen ? 'product.collapseAll' : 'product.expandAll')}</button>}
        <ProductMenu product={view.product} onChange={change} tracks={tracks} onTracks={changeTracks} />
        <button type="button" className="op-button" data-variant="primary" disabled={updating} aria-busy={updating || undefined}
          onClick={() => { void startUpdate() }}>{t(updating ? 'product.updating' : 'product.updateNow')}</button>
      </div>}
    </header>
    {updateNote && <p className="op-phead-error" role="alert">{updateNote}</p>}
    {!view && profile.error && <p className="op-day-problem" role="alert">{describeError(t, profile.error)}</p>}

    {view && <>
      <div className="op-tabs" role="tablist" aria-label={t('product.tabs')} onKeyDown={onTabKey}>
        {TABS.map(item => <button key={item} type="button" role="tab" id={`${ids}-${item}`} className="op-tab" aria-selected={tab === item}
          aria-controls={`${ids}-panel`} tabIndex={tab === item ? 0 : -1} onClick={() => { go(item) }}>
          {t(`product.tab.${item}`)}
          {item === 'feed' && feedCount > 0 && <span className="op-tab-count">{feedCount}</span>}
          {item === 'sources' && listedSources > 0 && <span className="op-tab-n">{listedSources}</span>}
        </button>)}
      </div>
      <div className="op-tabpanel" role="tabpanel" id={`${ids}-panel`} aria-labelledby={`${ids}-${tab}`}>
        {tab === 'dossier' && <DossierTab view={view} expanded={expanded} onToggle={toggle} focus={expand} now={now} />}
        {tab === 'feed' && (feed.data
          ? <FeedTab product={view.product} findings={feed.data.findings} sources={[...feed.data.sources, ...view.sources]} dimensions={view.dimensions} changed={feed.data.changed} />
          : feed.error && <p className="op-day-problem" role="alert">{describeError(t, feed.error)}</p>)}
        {tab === 'sources' && <SourcesTab view={view} />}
      </div>
    </>}
  </div>
}
