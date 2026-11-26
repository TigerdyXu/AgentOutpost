/**
 * 今日哨报 (design §5.2, mockup 2 option A): the page the panel opens on. The day, when it finished and how much there is
 * to read; the day before and 全部已读; the one-sentence summary; the track filter; one stream of cards in the brief's
 * order; the minor updates folded into one row; what could not be run; and the products with no news.
 *
 * A card that has been in the viewport and then leaves it counts as read (it fades); the panel then reads the state again,
 * so the middle column's 「n 条新」 and the sidebar count follow. Nothing is marked on rendering.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Brief, Finding, Id, Product, Source, Track } from '../../core/types.ts'
import { call, describeError, usePoll } from '../api.ts'
import type { T } from '../locales.ts'
import { PROMOTED, VERIFY_BUDGET } from '../notes.ts'
import { useShell } from '../shell/context.ts'
import { clockTime } from '../time.ts'
import { FindingCard } from '../ui/FindingCard.tsx'
import { ChevronIcon } from '../ui/icons.tsx'
import { ProductIcon } from '../ui/ProductIcon.tsx'
import { Tag } from '../ui/Tag.tsx'

/** How often an open page reads the brief again (a late finding, a brief written while it is open). */
const POLL_MS = 5000

/** 「11月25日 · 周二」 for the local day `YYYY-MM-DD`. */
function dayTitle(t: T, day: string): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  const weekday = new Date(year, month - 1, date).getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6
  return t('today.date', { month, day: date, weekday: t(`weekday.${weekday}`) })
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
    // Only what the check verified went into the profile (design §8), and only where a card took a version resting on it.
    const changed = finding.status === 'verified' ? (view.changed?.[finding.id] ?? []).map(key => ({ key, label: labels.get(key) ?? key })) : []
    return <FindingCard key={finding.id} finding={finding} product={product} trackName={tracks[0]?.name}
      sources={finding.sourceIds.flatMap(id => index.sources.get(id) ?? [])} changed={changed} read={finding.read || read.has(finding.id)}
      promoted={finding.verifiedOn === brief!.date && finding.statusNote === PROMOTED}
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
