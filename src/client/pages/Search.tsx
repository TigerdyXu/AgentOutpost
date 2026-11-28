/**
 * The search page (M3.2): what Outpost holds that has every word of the query in it, by kind (products, tracks, dossier
 * cards, findings, topics), each with the words marked in a snippet; choosing one opens it (a card expanded, a finding
 * scrolled to). The query is typed in the middle column's box.
 */
import { Fragment, type ReactNode } from 'react'
import type { Span } from '../../core/types.ts'
import type { SearchResults, Snippet } from '../../host/search.ts'
import { call, describeError, usePoll } from '../api.ts'
import type { OutpostKey } from '../locales.ts'
import { useShell } from '../shell/context.ts'
import type { Route } from '../shell/route.ts'
import { Tag } from '../ui/Tag.tsx'
import { counted, labelOf } from '../words.ts'

/** Results do not change unless Outpost writes something; they are read again now and then while the page is open. */
const SEARCH_POLL_MS = 60_000

/** The snippet's text with the query's words marked. */
function Marked({ snippet }: { snippet: Snippet }): ReactNode {
  const parts: ReactNode[] = []
  let at = 0
  snippet.marks.forEach((mark: Span, i) => {
    if (mark.start > at) parts.push(<Fragment key={`t${i}`}>{snippet.text.slice(at, mark.start)}</Fragment>)
    parts.push(<mark key={`m${i}`} className="op-search-mark">{snippet.text.slice(mark.start, mark.end)}</mark>)
    at = mark.end
  })
  if (at < snippet.text.length) parts.push(<Fragment key="end">{snippet.text.slice(at)}</Fragment>)
  return <>{parts}</>
}

/** One hit: what it is (`head`), and the snippet; choosing it opens `to`. */
function Hit({ head, snippet, to }: { head: ReactNode; snippet?: Snippet; to: Route }): ReactNode {
  const { navigate } = useShell()
  return <li>
    <button type="button" className="op-search-hit" onClick={() => { navigate(to) }}>
      <span className="op-search-head">{head}</span>
      {snippet && <span className="op-search-snippet"><Marked snippet={snippet} /></span>}
    </button>
  </li>
}

/** A kind of hit, with its count, and how many more were found than are listed. */
function Group({ title, count, more, children }: { title: OutpostKey; count: number; more: number; children: ReactNode }): ReactNode {
  const { t } = useShell()
  if (count === 0) return null
  return <section className="op-search-group">
    <h2 className="op-search-group-title">{t(title)}<span className="op-search-count">{count + more}</span></h2>
    <ul className="op-search-list">{children}</ul>
    {more > 0 && <p className="op-search-more">{t('search.more', { count: more })}</p>}
  </section>
}

export function Search(): ReactNode {
  const { t, route } = useShell()
  const q = route.page === 'search' ? route.q : ''
  const { data, error } = usePoll<SearchResults | null>(() => q ? call('GET search', { query: { q } }) : Promise.resolve(null), [q], SEARCH_POLL_MS)
  const current = data && data.query === q ? data : null
  const total = current ? current.products.length + current.tracks.length + current.cards.length + current.findings.length + current.topics.length : 0
  const more = current ? Object.values(current.more).reduce((sum, n) => sum + n, 0) : 0
  return <div className="op-page op-search">
    <h1 className="op-page-title">{q ? t('search.title', { q }) : t('search.titleEmpty')}</h1>
    {!q && <p className="op-search-note">{t('search.empty')}</p>}
    {q && error && <p className="op-day-problem" role="alert">{describeError(t, error)}</p>}
    {q && !current && !error && <p className="op-search-note" role="status">{t('search.searching')}</p>}
    {current && total === 0 && <p className="op-search-note" role="status">{t('search.none', { q })}</p>}
    {current && total > 0 && <>
      <p className="op-search-found" role="status">{counted(t, 'search.found', { count: total + more })}</p>
      <Group title="search.group.products" count={current.products.length} more={current.more.products}>
        {current.products.map(hit => <Hit key={hit.id} to={{ page: 'product', productId: hit.id, tab: 'dossier' }}
          head={<><b>{hit.name}</b><span className="op-search-meta">{[hit.company, ...hit.tracks].join(' · ')}</span>
            {hit.inNote && <span className="op-search-note-tag">{t('search.inNote')}</span>}</>}
          {...hit.inNote ? { snippet: hit.snippet } : {}} />)}
      </Group>
      <Group title="search.group.tracks" count={current.tracks.length} more={current.more.tracks}>
        {current.tracks.map(hit => <Hit key={hit.id} to={{ page: 'track', trackId: hit.id }} head={<b>{hit.name}</b>} snippet={hit.snippet} />)}
      </Group>
      <Group title="search.group.cards" count={current.cards.length} more={current.more.cards}>
        {current.cards.map(hit => <Hit key={`${hit.productId}:${hit.dimension}`} to={{ page: 'product', productId: hit.productId, tab: 'dossier', expand: hit.dimension }}
          head={<><b>{hit.product}</b><span className="op-search-meta">{labelOf(t, { key: hit.dimension, label: hit.label })}</span></>} snippet={hit.snippet} />)}
      </Group>
      <Group title="search.group.findings" count={current.findings.length} more={current.more.findings}>
        {current.findings.map(hit => <Hit key={hit.id} to={{ page: 'product', productId: hit.productId, tab: 'feed', finding: hit.id }}
          head={<><b>{hit.product}</b><span className="op-search-meta">{hit.date.slice(5)}</span>
            {hit.status === 'unconfirmed' && <Tag kind="unconfirmed" />}
            {hit.status === 'unproven' && <span className="op-search-meta">{t('feed.unproven')}</span>}
            {hit.inNote && <span className="op-search-note-tag">{t('search.inNote')}</span>}
            {/* Found in why it matters: the headline still says which finding it is. */}
            {!hit.inHeadline && <span className="op-search-headline">{hit.headline}</span>}</>}
          snippet={hit.snippet} />)}
      </Group>
      <Group title="search.group.topics" count={current.topics.length} more={current.more.topics}>
        {current.topics.map(hit => <Hit key={hit.id} to={{ page: 'topic', topicId: hit.id }}
          head={<><b>{hit.question}</b><span className="op-search-meta">{hit.track}</span></>} snippet={hit.snippet} />)}
      </Group>
    </>}
  </div>
}
