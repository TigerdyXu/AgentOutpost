/**
 * 来源 (design §5.4): every source the profile cites: its title (a link), who published it and when, what kind of source it
 * is, whether it is the product's own, and which conclusions cite it. The most cited come first, then the newest.
 *
 * 官方 is what the check found (`isOwnSource`): a source handed in as an 「官方发布」 reads 「官方（未核实）」 until a check has
 * said who published it, and 「不是官方」 once the check said someone else did.
 */
import type { ReactNode } from 'react'
import { isOwnSource } from '../../../core/credibility.ts'
import type { Source, SourceKind } from '../../../core/types.ts'
import type { ProductView } from '../../../host/api.ts'
import { useShell } from '../../shell/context.ts'
import { Tag } from '../../ui/Tag.tsx'

const KINDS: Record<SourceKind, 'sources.kind.official' | 'sources.kind.media' | 'sources.kind.review' | 'sources.kind.appstore' | 'sources.kind.social'> = {
  official: 'sources.kind.official', media: 'sources.kind.media', review: 'sources.kind.review', appstore: 'sources.kind.appstore', social: 'sources.kind.social',
}

/** The kind as the page names it: an 「官方发布」 the check has not agreed to says so. */
function kindKey(source: Source): (typeof KINDS)[SourceKind] | 'sources.kind.officialUnchecked' | 'sources.kind.officialRefused' {
  if (source.kind !== 'official' || isOwnSource(source)) return KINDS[source.kind]
  return source.officialConfirmed === false ? 'sources.kind.officialRefused' : 'sources.kind.officialUnchecked'
}

/**
 * Which dimensions cite each source (by label, in the order the page lists the dimensions), and the sources a card on the
 * page cites. A card of a dimension that no track of the product lists is not on the page, so what only it cites is not
 * listed, and the dimension is not named.
 */
export function citations(view: Pick<ProductView, 'cards' | 'dimensions' | 'sources'>): { citedBy: Map<string, string[]>; sources: Source[] } {
  const citedBy = new Map<string, string[]>()
  for (const { key, label } of view.dimensions) {
    const card = view.cards.find(item => item.dimension === key)
    for (const id of new Set(card?.sourceIds)) citedBy.set(id, [...citedBy.get(id) ?? [], label])
  }
  return { citedBy, sources: view.sources.filter(source => citedBy.has(source.id)) }
}

export function SourcesTab({ view }: { view: ProductView }): ReactNode {
  const { t } = useShell()
  const { citedBy, sources } = citations(view)
  const count = (source: Source) => citedBy.get(source.id)?.length ?? 0
  const rows = [...sources].sort((a, b) => count(b) - count(a)
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
              {isOwnSource(source) && <Tag kind="official" />}
              {source.openedVia === 'unopened' && <Tag kind="unopened" />}
            </td>
            <td>{source.publisher || t('dossier.fact.none')}</td>
            <td className="op-sources-date">{source.publishedAt?.slice(0, 10) || t('dossier.fact.none')}</td>
            <td className="op-sources-kind">{t(kindKey(source))}</td>
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
