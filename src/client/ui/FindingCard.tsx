/**
 * A finding as a card (design §5.2): who, what, why it matters, its sources, how far it can be trusted, which dimensions
 * of the profile it changed, and 追问. The brief and the product's 动态 tab show the same card.
 */
import { useRef, type ReactNode } from 'react'
import type { DimensionKey, Finding, Id, Product, Source } from '../../core/types.ts'
import { canonicalUrl } from '../../core/url.ts'
import { UNOPENED } from '../notes.ts'
import { useShell } from '../shell/context.ts'
import { ProductIcon } from './ProductIcon.tsx'
import { SourceChip } from './SourceChip.tsx'
import { Tag } from './Tag.tsx'
import { useFollowup } from './useFollowup.ts'
import { useLeaveViewport } from './useLeaveViewport.ts'
import { told } from '../words.ts'

export interface FindingCardProps {
  finding: Finding
  product: Product
  /** The track the product is in, when it is in one. */
  trackName: string | undefined
  sources: Source[]
  /** The dimensions the finding changed (a card version rests on it), the first one first: 看改动 opens that one. */
  changed: { key: DimensionKey; label: string }[]
  /** It was 「待确认」 before and has been verified: tagged 已证实. */
  promoted: boolean
  /** Faded: the reader has been past it. */
  read?: boolean
  minor?: boolean
  /** Called when the card has been in the viewport and left it; without it, the card is never marked read by being seen. */
  onRead?: (id: Id) => void
  /** The one a link asked to show (a search hit): outlined. */
  focused?: boolean
}

export function FindingCard({ finding, product, trackName, sources, changed, promoted, read = false, minor, onRead, focused = false }: FindingCardProps): ReactNode {
  const { t, navigate } = useShell()
  const card = useRef<HTMLElement>(null)
  useLeaveViewport(card, read || !onRead, () => { onRead?.(finding.id) })
  const { ask, asking, problem } = useFollowup(finding.id)
  // One chip per page: a finding handed in before sources were kept one per page may list one twice.
  const pages = sources.filter((source, i) => sources.findIndex(other => canonicalUrl(other.url) === canonicalUrl(source.url)) === i)

  const unconfirmed = finding.status === 'unconfirmed'
  const unproven = finding.status === 'unproven'
  // A chip that says 原文打不开 already tells it; the finding says it only when none does.
  const sayUnopened = (unconfirmed || unproven) && finding.statusNote === UNOPENED && !pages.some(source => source.openedVia === 'unopened')
  const plainNote = (unconfirmed || unproven) && finding.statusNote !== null && finding.statusNote !== UNOPENED ? told(t, finding.statusNote) : null
  return <article ref={card} className="op-card" data-finding={finding.id} data-focused={focused ? '' : undefined} data-read={read ? '' : undefined} data-minor={minor ? '' : undefined} data-importance={finding.importance}>
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
      {pages.map(source => <SourceChip key={source.id} source={source} />)}
      {(unconfirmed || unproven) && <span className="op-card-status">
        {unconfirmed ? <Tag kind="unconfirmed" /> : <span className="op-card-unproven">{t('feed.unproven')}</span>}
        {sayUnopened && <Tag kind="unopened" />}{plainNote && <span className="op-card-note">{plainNote}</span>}
      </span>}
      {changed.length > 0 && <span className="op-card-changed">
        {t('today.changed')}{changed.flatMap(({ key, label }, i) => [i > 0 ? t('today.list') : '', <b key={key}>{label}</b>])}
      </span>}
      <span className="op-card-actions">
        {changed.length > 0 && <button type="button" className="op-link"
          onClick={() => { navigate({ page: 'product', productId: finding.productId, tab: 'dossier', expand: changed[0]!.key }) }}>{t('today.look')}</button>}
        <button type="button" className="op-link" disabled={asking} aria-busy={asking || undefined} onClick={() => { void ask() }}>{t('today.followup')}</button>
      </span>
    </div>
    {problem && <p className="op-card-error" role="alert">{problem}</p>}
  </article>
}
