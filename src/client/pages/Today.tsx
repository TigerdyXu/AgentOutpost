/**
 * 今日哨报 (design §5.2, mockup 2 option A): the page the panel opens on. The day, when it finished and how much there is
 * to read; the day before and 全部已读; the one-sentence summary; the track filter; one stream of cards in the brief's
 * order; the minor updates folded into one row; what could not be run; and the products with no news.
 *
 * A card that has been in the viewport and then leaves it counts as read (it fades); the panel then reads the state again,
 * so the middle column's 「n 条新」 and the sidebar count follow. Nothing is marked on rendering.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Brief, Finding, Id, Product, Source, Track } from '../../core/types.ts'
import { call, describeError, usePoll } from '../api.ts'
import type { T } from '../locales.ts'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { PROMOTED, UNOPENED, VERIFY_BUDGET } from '../notes.ts'
import { useShell } from '../shell/context.ts'
import { ChevronIcon } from '../ui/icons.tsx'
import { ProductIcon } from '../ui/ProductIcon.tsx'
import { SourceChip } from '../ui/SourceChip.tsx'
import { Tag } from '../ui/Tag.tsx'

/** How often an open page reads the brief again (a late finding, a brief written while it is open). */
const POLL_MS = 5000

const pad = (n: number) => String(n).padStart(2, '0')

/** 「11月25日 · 周二」 for the local day `YYYY-MM-DD`. */
function dayTitle(t: T, day: string): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  const weekday = new Date(year, month - 1, date).getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6
  return t('today.date', { month, day: date, weekday: t(`weekday.${weekday}`) })
}

/** The time of day of an ISO instant on the reader's clock (`08:12`), or null for one that is no date. */
function clockTime(iso: string): string | null {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : `${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * What the brief says about the products it could not update: one line per reason for those the budget stopped (the
 * reason once, over their names), then one per product whose check the budget cut short, then one per failure.
 */
function skippedNotes(t: T, skipped: Brief['skipped'], nameOf: (id: Id) => string | undefined): string[] {
  const stopped = new Map<string, string[]>()
  const unchecked: string[] = []
  const failed: string[] = []
  for (const entry of skipped) {
    const name = nameOf(entry.productId)
    if (name === undefined) continue
    if (entry.failed) failed.push(t('today.failed', { name, reason: entry.reason }))
    else if (entry.reason === VERIFY_BUDGET) unchecked.push(t('today.verifyBudget', { name }))
    else stopped.set(entry.reason, [...stopped.get(entry.reason) ?? [], name])
  }
  return [
    ...[...stopped].map(([reason, names]) => t('today.skipped', { names: names.join(t('today.list')), reason })),
    ...unchecked,
    ...failed,
  ]
}

/** Calls `onLeave` once the element has been in the viewport and then is not; never while `done`, nor where the browser has no observer. */
function useLeaveViewport(ref: RefObject<Element | null>, done: boolean, onLeave: () => void): void {
  const latest = useRef(onLeave)
  latest.current = onLeave
  useEffect(() => {
    const element = ref.current
    if (done || !element || typeof IntersectionObserver === 'undefined') return
    let seen = false
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) seen = true
        else if (seen) { observer.disconnect(); latest.current(); return }
      }
    })
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [ref, done])
}

interface CardProps {
  finding: Finding
  /** The day of the brief the card is in. */
  day: string
  product: Product
  /** The track the product is in, when it is in one. */
  trackName: string | undefined
  sources: Source[]
  /** Labels of the dimensions the finding changed, the first one first. */
  changed: string[]
  read: boolean
  minor?: boolean
  onRead: (id: Id) => void
}

function FindingCard({ finding, day, product, trackName, sources, changed, read, minor, onRead }: CardProps): ReactNode {
  const { t, navigate, sessions } = useShell()
  const card = useRef<HTMLElement>(null)
  useLeaveViewport(card, read, () => { onRead(finding.id) })

  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const opening = useRef<AbortController | null>(null)
  useEffect(() => () => { opening.current?.abort() }, [])
  /** 追问: the host starts the session; then it is opened in the workspace once DSH lists it. */
  const ask = async () => {
    setAsking(true)
    setProblem(null)
    const controller = new AbortController()
    opening.current = controller
    try {
      const { sessionId } = await call('POST followup', { body: { findingId: finding.id } })
      if (!sessions) throw new SessionNavigationError('not-ready')
      await openKnownSession(sessions.catalog, sessionId as SessionId, sessions.open, controller.signal)
    } catch (error) {
      setProblem(error instanceof SessionNavigationError ? t(error.code === 'not-ready' ? 'today.sessionNotReady' : 'today.sessionNotListed')
        : describeError(t, error instanceof Error ? error : new Error(String(error))))
    } finally {
      setAsking(false)
    }
  }

  const promoted = finding.verifiedOn === day && finding.statusNote === PROMOTED
  const unconfirmed = finding.status === 'unconfirmed'
  // A chip that says 原文打不开 already tells it; the finding says it only when none does.
  const sayUnopened = unconfirmed && finding.statusNote === UNOPENED && !sources.some(source => source.openedVia === 'unopened')
  const plainNote = unconfirmed && finding.statusNote !== null && finding.statusNote !== UNOPENED ? finding.statusNote : null
  return <article ref={card} className="op-card" data-read={read ? '' : undefined} data-minor={minor ? '' : undefined} data-importance={finding.importance}>
    <div className="op-card-head">
      <ProductIcon product={product} size={22} />
      <span className="op-card-product">{product.name}</span>
      {trackName && <span className="op-card-track">· {trackName}</span>}
      {promoted && <Tag kind="promoted" />}
      {finding.late && <Tag kind="late" />}
      {finding.inference && <Tag kind="inference" />}
      {(finding.importance === 'major' || finding.importance === 'notable') && <span className="op-card-level"><Tag kind={finding.importance} /></span>}
    </div>
    <h2 className="op-card-title">{finding.headline}</h2>
    {finding.why.trim() && <p className="op-card-why"><span className="op-card-why-label">{t('today.why')}</span>{finding.why}</p>}
    <div className="op-card-foot">
      {sources.map(source => <SourceChip key={source.id} source={source} />)}
      {unconfirmed && <span className="op-card-status">
        <Tag kind="unconfirmed" />{sayUnopened && <Tag kind="unopened" />}{plainNote && <span className="op-card-note">{plainNote}</span>}
      </span>}
      {changed.length > 0 && <span className="op-card-changed">
        {t('today.changed')}{changed.flatMap((label, i) => [i > 0 ? t('today.list') : '', <b key={label}>{label}</b>])}
      </span>}
      <span className="op-card-actions">
        {changed.length > 0 && <button type="button" className="op-link"
          onClick={() => { navigate({ page: 'product', productId: finding.productId, tab: 'dossier', expand: finding.dimensions[0]! }) }}>{t('today.look')}</button>}
        <button type="button" className="op-link" disabled={asking} aria-busy={asking || undefined} onClick={() => { void ask() }}>{t('today.followup')}</button>
      </span>
    </div>
    {problem && <p className="op-card-error" role="alert">{problem}</p>}
  </article>
}

export function Today(): ReactNode {
  const { t, route, navigate, state, refresh } = useShell()
  const date = route.page === 'today' ? route.date : undefined
  // The answer carries the day it was asked for, so that the previous day's page does not stand in while the next one loads.
  const { data, error } = usePoll(async () => ({ date, view: await call('GET brief', { query: date ? { date } : {} }) }), [date], POLL_MS)
  const view = data && data.date === date ? data.view : undefined

  // Cards read on this page, ahead of what the server says; and the folded row.
  const [read, setRead] = useState<ReadonlySet<Id>>(new Set())
  const [minorOpen, setMinorOpen] = useState(false)
  const [trackId, setTrackId] = useState<Id | null>(null)
  const [readingAll, setReadingAll] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  // One read of the state after a burst of cards leaving the viewport, not one each.
  const marking = useRef({ inflight: 0, changed: false })
  const markRead = useCallback(async (id: Id) => {
    setRead(previous => new Set(previous).add(id))
    marking.current.inflight++
    try {
      await call('POST findings/:id/read', { id })
      marking.current.changed = true
    } catch {
      setRead(previous => { const next = new Set(previous); next.delete(id); return next })
    } finally {
      if (--marking.current.inflight === 0 && marking.current.changed) { marking.current.changed = false; refresh() }
    }
  }, [refresh])

  const index = useMemo(() => ({
    findings: new Map<Id, Finding>(view?.findings.map(f => [f.id, f] as const)),
    products: new Map<Id, Product>(view?.products.map(p => [p.id, p] as const)),
    sources: new Map<Id, Source>(view?.sources.map(s => [s.id, s] as const)),
  }), [view])
  const tracksOf = (productId: Id): Track[] => state?.tracks.filter(entry => entry.products.some(item => item.product.id === productId)).map(entry => entry.track) ?? []
  const visible = (productId: Id) => trackId === null || tracksOf(productId).some(track => track.id === trackId)

  /** An earlier day than today's. */
  const past = date !== undefined && date !== state?.todayDate

  if (!view) {
    return <div className="op-page op-today">
      <h1 className="op-page-title">{t('nav.today')}</h1>
      {error && <p className="op-day-problem" role="status">{describeError(t, error)}</p>}
    </div>
  }

  const { brief, prevDate } = view
  const heading = brief?.date ?? date ?? state?.todayDate
  const present = (ids: Id[]) => ids.flatMap(id => index.findings.get(id) ?? [])
  const main = brief ? present(brief.findingIds) : []
  const minor = brief ? present(brief.minorIds) : []
  const noNews = main.length === 0 && minor.length === 0
  const everyFinding = [...main, ...minor]
  const allRead = everyFinding.every(f => f.read || read.has(f.id))

  const readAll = async () => {
    if (!brief) return
    setReadingAll(true)
    setProblem(null)
    try {
      await call('POST brief/read-all', { body: { date: brief.date } })
      setRead(previous => new Set([...previous, ...everyFinding.map(f => f.id)]))
      refresh()
    } catch (failure) {
      setProblem(describeError(t, failure instanceof Error ? failure : new Error(String(failure))))
    } finally {
      setReadingAll(false)
    }
  }

  const card = (finding: Finding, isMinor = false): ReactNode => {
    const product = index.products.get(finding.productId)
    if (!product) return null
    const tracks = tracksOf(product.id)
    const labels = new Map(tracks.flatMap(track => track.dimensions).map(dimension => [dimension.key, dimension.label] as const))
    // Only what the check verified went into the profile (design §8).
    const changed = finding.status === 'verified' ? finding.dimensions.map(key => labels.get(key) ?? key) : []
    return <FindingCard key={finding.id} finding={finding} day={brief!.date} product={product} trackName={tracks[0]?.name}
      sources={finding.sourceIds.flatMap(id => index.sources.get(id) ?? [])} changed={changed} read={finding.read || read.has(finding.id)}
      minor={isMinor} onRead={id => { void markRead(id) }} />
  }

  const shownMain = main.filter(f => visible(f.productId))
  const shownMinor = minor.filter(f => visible(f.productId))
  const countIn = (id: Id) => main.filter(f => tracksOf(f.productId).some(track => track.id === id)).length
  const finishedAt = brief ? clockTime(brief.createdAt) : null
  const unconfirmedCount = main.filter(f => f.status === 'unconfirmed').length
  const metaParts = brief ? [
    ...finishedAt ? [t('today.finished', { time: finishedAt })] : [],
    t('today.products', { count: view.products.length }),
    ...noNews ? [] : [t('today.worth', { count: main.length })],
    ...noNews || main.length === 0 ? [] : [unconfirmedCount > 0 ? t('today.unconfirmed', { count: unconfirmedCount }) : t('today.checked')],
  ] : []

  const notes = brief ? skippedNotes(t, brief.skipped.filter(entry => visible(entry.productId)), id => index.products.get(id)?.name) : []
  const quiet = brief ? brief.quietProductIds.flatMap(id => index.products.get(id) ?? []).filter(p => visible(p.id)) : []

  return <div className="op-page op-today">
    <header className="op-day-head">
      <div className="op-day-titles">
        <h1 className="op-page-title">{heading ? dayTitle(t, heading) : t('nav.today')}</h1>
        {metaParts.length > 0 && <p className="op-day-meta">{metaParts.join(' · ')}</p>}
      </div>
      <div className="op-day-nav">
        {past && <button type="button" className="op-button" data-size="small" onClick={() => { navigate({ page: 'today' }) }}>{t('today.back')}</button>}
        <button type="button" className="op-button" data-size="small" disabled={prevDate === null}
          onClick={() => { if (prevDate !== null) navigate({ page: 'today', date: prevDate }) }}>{t('today.prev')}</button>
        {!noNews && <button type="button" className="op-button" data-size="small" disabled={allRead || readingAll} onClick={() => { void readAll() }}>{t('today.readAll')}</button>}
      </div>
    </header>
    {problem && <p className="op-day-problem" role="alert">{problem}</p>}

    {!brief && <p className="op-day-empty">{past ? t('today.noBriefThatDay') : state ? t('today.noBrief', { time: state.runTime }) : t('today.noBriefAnyTime')}</p>}
    {brief && noNews && <p className="op-day-empty">{t('today.noNews')}</p>}
    {brief && !noNews && <>
      {brief.gist && <div className="op-gist"><Tag kind="ai" /><span>{brief.gist}</span></div>}
      {state && main.length > 0 && state.tracks.some(entry => entry.products.length > 0) && <div className="op-filter" role="group" aria-label={t('today.filter')}>
        <button type="button" aria-pressed={trackId === null} onClick={() => { setTrackId(null) }}>{t('today.all', { count: main.length })}</button>
        {state.tracks.filter(entry => entry.products.length > 0).map(({ track }) => <button key={track.id} type="button" aria-pressed={trackId === track.id}
          onClick={() => { setTrackId(track.id) }}>{`${track.name} ${countIn(track.id)}`}</button>)}
      </div>}
      {shownMain.length > 0 && <div className="op-cards">{shownMain.map(finding => card(finding))}</div>}
      {shownMinor.length > 0 && <>
        <button type="button" className="op-fold" aria-expanded={minorOpen} onClick={() => { setMinorOpen(open => !open) }}>
          <ChevronIcon size={14} />
          <span>{minorOpen ? t('today.minorHide') : t('today.minor', { count: shownMinor.length })}</span>
        </button>
        {minorOpen && <div className="op-cards">{shownMinor.map(finding => card(finding, true))}</div>}
      </>}
    </>}
    {notes.map(line => <p key={line} className="op-day-note">{line}</p>)}
    {!noNews && quiet.length > 0 && <p className="op-quiet">
      <span>{t('today.quiet')}</span>
      {quiet.map(item => <span key={item.id} className="op-quiet-item"><ProductIcon product={item} size={18} /><span>{item.name}</span></span>)}
    </p>}
  </div>
}
