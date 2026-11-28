/**
 * 专题页 (M2.3, design §5.6): the question; its track, products, how often it is looked into again and its versions; the
 * newest version's conclusion cards, laid out as a dossier's (title, one-line conclusion, bullets; 「展开」 for the full
 * text, whose [n] open their sources, and the sources); what each version changed. 「立即更新」 runs a round now; the 「⋯」
 * changes how often and deletes the topic.
 */
import { useId, useState, type ReactNode } from 'react'
import type { Id, Source, TopicCard } from '../../core/types.ts'
import type { TopicView } from '../../host/api.ts'
import { call, describeError, usePoll } from '../api.ts'
import { useShell } from '../shell/context.ts'
import { shortDay } from '../time.ts'
import { SourceChip } from '../ui/SourceChip.tsx'
import { told } from '../words.ts'
import { RichText } from './product/richText.tsx'

/** How often the page reads the topic again: quickly while a round runs (its cards appear when it is over). */
const BUSY_POLL_MS = 3000
const IDLE_POLL_MS = 15_000

const errorOf = (failure: unknown) => failure instanceof Error ? failure : new Error(String(failure))
/** `MM-DD` for a local day `YYYY-MM-DD` of this year, else the day as it is. */
const dayLabel = (day: string) => day.startsWith(`${new Date().getFullYear()}-`) ? day.slice(5) : day

export function Topic(): ReactNode {
  const { t, route } = useShell()
  const topicId = route.page === 'topic' ? route.topicId : ''
  const answer = usePoll(() => call('GET topics/:id', { id: topicId }), [topicId], view => view?.row.researching ? BUSY_POLL_MS : IDLE_POLL_MS)
  if (route.page !== 'topic') return null
  const view = answer.data?.row.topic.id === topicId ? answer.data : undefined
  if (!view) {
    return <div className="op-page op-topic-page">
      {answer.error && <p className="op-day-problem" role="alert">{describeError(t, answer.error)}</p>}
    </div>
  }
  return <TopicPage key={view.row.topic.id} view={view} reload={answer.reload} />
}

function TopicPage({ view, reload }: { view: TopicView; reload: () => Promise<void> }): ReactNode {
  const { t, navigate, refresh } = useShell()
  const { row, track, products, version, history } = view
  const { topic } = row
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [asking, setAsking] = useState(false) // 删除专题 asks once more
  const sources = new Map(view.sources.map(source => [source.id, source]))
  const nameOf = new Map(products.map(p => [p.id, p.name]))

  const act = async (work: () => Promise<unknown>, after?: () => void) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
      if (after) after()
      else await reload()
    } catch (failure) {
      setProblem(describeError(t, errorOf(failure)))
    } finally {
      setBusy(false)
    }
  }
  const update = () => act(() => call('POST topics/:id/update', { id: topic.id }))
  const switchCadence = () => act(() => call('PATCH topics/:id', { id: topic.id, body: { cadence: topic.cadence === 'weekly' ? 'once' : 'weekly' } }))
  const remove = () => act(() => call('POST topics/:id/delete', { id: topic.id }), () => { refresh(); navigate({ page: 'track', trackId: track.id }) })

  const meta = [
    t('topic.ofTrack', { track: track.name }),
    t(topic.cadence === 'weekly' ? 'topic.weekly' : 'topic.once'),
    ...version ? [t('topic.versionOf', { n: version.version ?? 0, date: shortDay(version.createdAt) ?? '' })] : [],
    ...topic.cadence === 'weekly' && row.next ? [t('topic.next', { date: dayLabel(row.next) })] : [],
  ].join(' · ')

  return <div className="op-page op-topic-page">
    <header className="op-thead">
      <div className="op-thead-titles">
        <h1 className="op-page-title">{topic.question}</h1>
        <p className="op-thead-meta">{meta}</p>
        <p className="op-topic-with">
          <span>{t('topic.with')}</span>
          {products.map(p => <button key={p.id} type="button" className="op-link" onClick={() => { navigate({ page: 'product', productId: p.id, tab: 'topics' }) }}>{p.name}</button>)}
        </p>
      </div>
      <div className="op-phead-actions">
        <button type="button" className="op-button" disabled={busy || row.researching} onClick={() => { void switchCadence() }}>
          {t(topic.cadence === 'weekly' ? 'topic.makeOnce' : 'topic.makeWeekly')}</button>
        <button type="button" className="op-button" data-variant="primary" disabled={busy || row.researching} aria-busy={row.researching || undefined}
          onClick={() => { void update() }}>{t(row.researching ? 'topic.updating' : 'topic.update')}</button>
      </div>
    </header>
    {problem && <p className="op-form-problem" role="alert">{problem}</p>}
    {row.researching && <p className="op-tsection-note" role="status">{t('topic.researchingLong')}</p>}
    {!row.researching && row.problem && <p className="op-form-problem" role="alert">{t('topic.noNewVersion', { reason: told(t, row.problem) })}</p>}
    {version?.changeNote && history.length > 1 && <div className="op-gist"><span>{t('topic.changed', { note: version.changeNote })}</span></div>}

    {version
      ? <div className="op-dgrid op-topic-cards">{version.cards.map((card, i) => <TopicCardView key={i} card={card} sources={sources} nameOf={nameOf} />)}</div>
      : !row.researching && <p className="op-zone-text">{t('topic.empty')}</p>}

    {history.length > 1 && <section className="op-tsection">
      <h2 className="op-zone-title">{t('topic.history')}</h2>
      <ol className="op-topic-history">
        {history.map(entry => <li key={entry.version}>
          <span className="op-history-date">{t('topic.versionOf', { n: entry.version, date: shortDay(entry.createdAt) ?? '' })}</span>
          <span>{entry.changeNote}</span>
        </li>)}
      </ol>
    </section>}

    <section className="op-danger-zone">
      {!asking
        ? <button type="button" className="op-button" onClick={() => { setAsking(true) }} disabled={row.researching}>{t('topic.delete')}</button>
        : <>
          <p className="op-zone-text">{t('topic.deleteAsk')}</p>
          <div className="op-form-actions">
            <button type="button" className="op-button" data-variant="danger" disabled={busy} onClick={() => { void remove() }}>{t('topic.deleteConfirm')}</button>
            <button type="button" className="op-button" autoFocus onClick={() => { setAsking(false) }}>{t('topic.cancel')}</button>
          </div>
        </>}
    </section>
  </div>
}

/** One conclusion card: as a dossier card shows, with the products it is about. */
function TopicCardView({ card, sources, nameOf }: { card: TopicCard; sources: Map<Id, Source>; nameOf: Map<Id, string> }): ReactNode {
  const { t } = useShell()
  const ids = useId()
  const [open, setOpen] = useState(false)
  const sourceOf = (n: number) => { const id = card.sourceIds[n - 1]; return id === undefined ? undefined : sources.get(id) }
  const about = card.productIds.flatMap(id => nameOf.get(id) ?? [])
  return <article className="op-dcard op-topic-card" data-state="card" data-expanded={open ? '' : undefined}>
    <header className="op-dcard-head">
      <h3 className="op-dcard-name" id={`${ids}-name`}>{card.title}</h3>
      <button type="button" className="op-dcard-toggle" aria-expanded={open} aria-controls={`${ids}-body`} aria-labelledby={`${ids}-toggle ${ids}-name`}
        id={`${ids}-toggle`} onClick={() => { setOpen(!open) }}>{t(open ? 'dossier.collapse' : 'dossier.expand')}</button>
    </header>
    <p className="op-topic-summary">{card.summary}</p>
    {about.length > 0 && <p className="op-topic-about">{about.join(t('today.list'))}</p>}
    <div id={`${ids}-body`}>
      {!open && <>
        <ul className="op-dcard-bullets">{card.bullets.map((bullet, i) => <li key={i}><RichText text={bullet} sourceOf={sourceOf} /></li>)}</ul>
        <p className="op-dcard-count">{t('dossier.sourceCount', { count: card.sourceIds.length })}</p>
      </>}
      {open && <div className="op-dcard-main">
        <p className="op-dcard-text"><RichText text={card.body} sourceOf={sourceOf} inference={card.inferenceSpans} /></p>
        <div className="op-dcard-sources" role="group" aria-label={t('dossier.sources')}>
          {card.sourceIds.map((id, i) => { const source = sources.get(id); return source ? <SourceChip key={id} source={source} n={i + 1} /> : null })}
        </div>
      </div>}
    </div>
  </article>
}
