/**
 * 来源 (design §5.4): every source the profile cites: its title (a link), who published it and when, what kind of source it
 * is, whether it is the product's own, and which conclusions cite it. The most cited come first, then the newest.
 *
 * 官方 is what the check found (`isOwnSource`): a source handed in as an 「官方发布」 reads 「官方（未核实）」 until a check has
 * said who published it, and 「不是官方」 once the check said someone else did.
 */
import type { ReactNode } from 'react'
import { isOwnSource } from '../../../core/credibility.ts'
import { canonicalUrl } from '../../../core/url.ts'
import type { Dimension, Source, SourceKind } from '../../../core/types.ts'
import type { ProductView } from '../../../host/api.ts'
import { useShell } from '../../shell/context.ts'
import { Tag } from '../../ui/Tag.tsx'
import { counted, labelOf } from '../../words.ts'

const KINDS: Record<SourceKind, 'sources.kind.official' | 'sources.kind.media' | 'sources.kind.review' | 'sources.kind.appstore' | 'sources.kind.social'> = {
  official: 'sources.kind.official', media: 'sources.kind.media', review: 'sources.kind.review', appstore: 'sources.kind.appstore', social: 'sources.kind.social',
}

/** The kind as the page names it: an 「官方发布」 the check has not agreed to says so. */
function kindKey(source: Source): (typeof KINDS)[SourceKind] | 'sources.kind.officialUnchecked' | 'sources.kind.officialRefused' {
  if (source.kind !== 'official' || isOwnSource(source)) return KINDS[source.kind]
  return source.officialConfirmed === false ? 'sources.kind.officialRefused' : 'sources.kind.officialUnchecked'
}

/** Which of a page's stored copies speaks for it: one the check found the maker's own, then one that opened (one the check turned down first), then the rest. */
const rank = (s: Source) => isOwnSource(s) ? 0 : s.openedVia === 'unopened' ? 3 : s.officialConfirmed === false ? 1 : 2

/**
 * The pages the profile cites, one row each however many cards cite them (M1.6: each card keeps its own copy of a source,
 * so one article cited by four cards is four stored sources), shown as their best copy (`rank`), in the order the view
 * lists them; and which dimensions cite each (by `name`, in the order the page lists the dimensions, each once), keyed by
 * that copy's id. A card of a dimension that no track of the product lists is not on the page, so what only it cites is
 * not listed, and the dimension is not named.
 */
export function citations(view: Pick<ProductView, 'cards' | 'dimensions' | 'sources'>, name: (dimension: Dimension) => string = dimension => dimension.label): { citedBy: Map<string, string[]>; sources: Source[] } {
  const byId = new Map(view.sources.map(source => [source.id, source]))
  const labelsOf = new Map<string, string[]>() // by page
  for (const dimension of view.dimensions) {
    const label = name(dimension)
    const card = view.cards.find(item => item.dimension === dimension.key)
    for (const id of card?.sourceIds ?? []) {
      const source = byId.get(id)
      if (!source) continue
      const page = canonicalUrl(source.url)
      const labels = labelsOf.get(page) ?? []
      if (!labels.includes(label)) labels.push(label)
      labelsOf.set(page, labels)
    }
  }
  const copies = new Map<string, Source[]>() // by page, in the view's order
  for (const source of view.sources) {
    const page = canonicalUrl(source.url)
    if (labelsOf.has(page)) copies.set(page, [...copies.get(page) ?? [], source])
  }
  const citedBy = new Map<string, string[]>()
  const sources = [...copies].map(([page, all]) => {
    const best = all.reduce((kept, source) => rank(source) < rank(kept) ? source : kept)
    citedBy.set(best.id, labelsOf.get(page)!)
    return best
  })
  return { citedBy, sources }
}

export function SourcesTab({ view }: { view: ProductView }): ReactNode {
  const { t } = useShell()
  const { citedBy, sources } = citations(view, dimension => labelOf(t, dimension)) // a default dimension in the reader's language
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
              <span className="op-sources-count">{counted(t, 'sources.citedBy', { count: by.length })}</span>
              {by.length > 0 && <span className="op-sources-by">{by.join(t('today.list'))}</span>}
            </td>
          </tr>
        })}
      </tbody>
    </table>
  </div>
}
