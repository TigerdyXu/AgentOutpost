/**
 * 来源 (design §5.4): every source the profile cites: its title (a link), who published it and when, what kind of source it
 * is, whether it is the product's own, and which conclusions cite it. The most cited come first, then the newest.
 */
import type { ReactNode } from 'react'
import type { Source, SourceKind } from '../../../core/types.ts'
import type { ProductView } from '../../../host/api.ts'
import { useShell } from '../../shell/context.ts'
import { Tag } from '../../ui/Tag.tsx'

const KINDS: Record<SourceKind, 'sources.kind.official' | 'sources.kind.media' | 'sources.kind.review' | 'sources.kind.appstore' | 'sources.kind.social'> = {
  official: 'sources.kind.official', media: 'sources.kind.media', review: 'sources.kind.review', appstore: 'sources.kind.appstore', social: 'sources.kind.social',
}

export function SourcesTab({ view }: { view: ProductView }): ReactNode {
  const { t } = useShell()
  const labels = new Map(view.dimensions.map(dimension => [dimension.key, dimension.label] as const))
  // The dimensions whose card cites each source, in the order the page lists the dimensions.
  const order = [...view.dimensions.map(d => d.key), ...view.cards.map(card => card.dimension).filter(key => !labels.has(key))]
  const citedBy = new Map<string, string[]>()
  for (const key of order) {
    const card = view.cards.find(item => item.dimension === key)
    for (const id of new Set(card?.sourceIds)) citedBy.set(id, [...citedBy.get(id) ?? [], labels.get(key) ?? key])
  }
  const count = (source: Source) => citedBy.get(source.id)?.length ?? 0
  const rows = [...view.sources].sort((a, b) => count(b) - count(a)
    || (b.publishedAt ? Date.parse(b.publishedAt) || 0 : 0) - (a.publishedAt ? Date.parse(a.publishedAt) || 0 : 0))

  if (rows.length === 0) return <p className="op-day-empty">{t('sources.empty')}</p>
  return <div className="op-sources-wrap">
    <table className="op-sources">
      <thead>
        <tr>
          <th scope="col">{t('sources.title')}</th><th scope="col">{t('sources.publisher')}</th><th scope="col">{t('sources.date')}</th>
          <th scope="col">{t('sources.kind')}</th><th scope="col">{t('sources.cited')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(source => {
          const by = citedBy.get(source.id) ?? []
          return <tr key={source.id}>
            <td className="op-sources-title">
              <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title || source.url}</a>
              {source.isOfficial && <Tag kind="official" />}
              {source.openedVia === 'unopened' && <Tag kind="unopened" />}
            </td>
            <td>{source.publisher || t('dossier.fact.none')}</td>
            <td className="op-sources-date">{source.publishedAt?.slice(0, 10) || t('dossier.fact.none')}</td>
            <td className="op-sources-kind">{t(KINDS[source.kind])}</td>
            <td>
              <span className="op-sources-count">{t('sources.citedBy', { count: by.length })}</span>
              {by.length > 0 && <span className="op-sources-by">{by.join(t('today.list'))}</span>}
            </td>
          </tr>
        })}
      </tbody>
    </table>
  </div>
}
