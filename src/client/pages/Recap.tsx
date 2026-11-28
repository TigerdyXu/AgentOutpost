/**
 * A track's weekly recap (M3.4): its week, Monday to Sunday, with the AI's paragraph once the week is over, then what the
 * week held: the findings worth a look, the dossier's changes, products newly profiled, the map, topics updated, and the
 * products that were quiet. Each line opens what it is about. 「‹ 上一周」「下一周 ›」 move between weeks.
 */
import type { ReactNode } from 'react'
import type { RecapView } from '../../host/jobs/recap.ts'
import { call, describeError, usePoll } from '../api.ts'
import { useShell } from '../shell/context.ts'
import type { Route } from '../shell/route.ts'
import { Tag } from '../ui/Tag.tsx'
import { counted, labelOf } from '../words.ts'

/** A recap changes only when Outpost writes something: read again now and then while it is open. */
const RECAP_POLL_MS = 60_000

/** One line: what it is about (`head`), and more under it; choosing it opens `to`. */
function Line({ head, body, to }: { head: ReactNode; body?: ReactNode; to: Route }): ReactNode {
  const { navigate } = useShell()
  return <li>
    <button type="button" className="op-search-hit" onClick={() => { navigate(to) }}>
      <span className="op-search-head">{head}</span>
      {body && <span className="op-search-snippet">{body}</span>}
    </button>
  </li>
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }): ReactNode {
  return <section className="op-search-group">
    <h2 className="op-search-group-title">{title}{count !== undefined && <span className="op-search-count">{count}</span>}</h2>
    {children}
  </section>
}

export function Recap(): ReactNode {
  const { t, route, navigate } = useShell()
  const trackId = route.page === 'recap' ? route.trackId : ''
  const week = route.page === 'recap' ? route.week : undefined
  const { data, error } = usePoll(async () => ({ week, view: await call('GET tracks/:id/recap', { id: trackId, query: week ? { week } : {} }) }), [trackId, week], RECAP_POLL_MS)
  // While another week loads, the week shown stays (its header and buttons too, so focus is not lost), marked busy.
  const view: RecapView | undefined = data && data.view.track.id === trackId ? data.view : undefined
  const loading = !data || data.week !== week
  const go = (to: string | null) => { if (to) navigate({ page: 'recap', trackId, week: to }) }
  if (!view) {
    return <div className="op-page op-recap">
      {error ? <p className="op-day-problem" role="alert">{describeError(t, error)}</p> : <p className="op-search-note" role="status">{t('recap.loading')}</p>}
    </div>
  }
  const empty = !view.findings.length && !view.minor && !view.cardChanges.length && !view.newProducts.length && !view.map && !view.topics.length
  return <div className="op-page op-recap" aria-busy={loading || undefined} data-loading={loading ? '' : undefined}>
    <header className="op-recap-head">
      <div className="op-recap-titles">
        <h1 className="op-page-title">{t('recap.title', { track: view.track.name })}</h1>
        <p className="op-recap-range">{t('recap.range', { start: view.week.slice(5), end: view.end.slice(5) })}{!view.complete && <span className="op-recap-open">{t('recap.open')}</span>}</p>
      </div>
      <div className="op-recap-nav">
        <button type="button" className="op-button" data-size="small" disabled={!view.prev} onClick={() => { go(view.prev) }}>{t('recap.prev')}</button>
        <button type="button" className="op-button" data-size="small" disabled={!view.next} onClick={() => { go(view.next) }}>{t('recap.next')}</button>
      </div>
    </header>

    {view.gist ? <div className="op-gist"><Tag kind="ai" /><span>{view.gist}</span></div>
      : <p className="op-search-note">{t(!view.complete ? 'recap.gistPending' : view.gistDue ? 'recap.gistSoon' : 'recap.gistMissing')}</p>}
    {empty && <p className="op-search-note">{t('recap.empty')}</p>}

    {view.findings.length > 0 && <Section title={t('recap.findings')} count={view.findings.length}>
      <ul className="op-search-list">
        {view.findings.map(f => <Line key={f.id} to={{ page: 'product', productId: f.productId, tab: 'feed', finding: f.id }}
          head={<><b>{f.product}</b><span className="op-search-meta">{f.date.slice(5)}</span><Tag kind={f.importance === 'major' ? 'major' : 'notable'} />
            {f.status === 'unconfirmed' && <Tag kind="unconfirmed" />}<span className="op-search-headline">{f.headline}</span></>}
          body={f.why} />)}
      </ul>
    </Section>}
    {view.minor > 0 && <p className="op-search-more">{counted(t, 'recap.minor', { count: view.minor })}</p>}

    {view.cardChanges.length > 0 && <Section title={t('recap.cards')} count={view.cardChanges.length}>
      <ul className="op-search-list">
        {view.cardChanges.map((c, i) => <Line key={`${c.productId}:${c.dimension}:${i}`} to={{ page: 'product', productId: c.productId, tab: 'dossier', expand: c.dimension }}
          head={<><b>{c.product}</b><span className="op-search-meta">{labelOf(t, { key: c.dimension, label: c.label })} · {c.date.slice(5)}</span></>}
          body={c.changeNote} />)}
      </ul>
    </Section>}

    {view.newProducts.length > 0 && <Section title={t('recap.newProducts')}>
      <ul className="op-search-list">
        {view.newProducts.map(p => <Line key={p.id} to={{ page: 'product', productId: p.id, tab: 'dossier' }} head={<b>{p.name}</b>} />)}
      </ul>
    </Section>}

    {view.map && <Section title={t('recap.map')}>
      <ul className="op-search-list">
        <Line to={{ page: 'track', trackId }} head={<><Tag kind="inference" /><span className="op-search-meta">{view.map.date.slice(5)}</span></>}
          body={<>{view.map.gist}{view.map.moved.length > 0 && <><br />{t('recap.moved', { names: view.map.moved.join(t('today.list')) })}</>}</>} />
      </ul>
    </Section>}

    {view.topics.length > 0 && <Section title={t('recap.topics')} count={view.topics.length}>
      <ul className="op-search-list">
        {view.topics.map(topic => <Line key={`${topic.id}:${topic.version}`} to={{ page: 'topic', topicId: topic.id }}
          head={<><b>{topic.question}</b><span className="op-search-meta">{t('recap.topicVersion', { version: topic.version })} · {topic.date.slice(5)}</span></>}
          body={topic.changeNote} />)}
      </ul>
    </Section>}

    {view.quiet.length > 0 && !empty && <p className="op-search-note">{t('recap.quiet')}{view.quiet.join(t('today.list'))}</p>}
  </div>
}
