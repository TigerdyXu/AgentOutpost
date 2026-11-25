/**
 * A finding as a card (design §5.2): who, what, why it matters, its sources, how far it can be trusted, which dimensions
 * of the profile it changed, and 追问. The brief and the product's 动态 tab show the same card.
 */
import { useRef, type ReactNode } from 'react'
import type { Finding, Id, Product, Source } from '../../core/types.ts'
import { UNOPENED } from '../notes.ts'
import { useShell } from '../shell/context.ts'
import { ProductIcon } from './ProductIcon.tsx'
import { SourceChip } from './SourceChip.tsx'
import { Tag } from './Tag.tsx'
import { useFollowup } from './useFollowup.ts'
import { useLeaveViewport } from './useLeaveViewport.ts'

export interface FindingCardProps {
  finding: Finding
  product: Product
  /** The track the product is in, when it is in one. */
  trackName: string | undefined
  sources: Source[]
  /** Labels of the dimensions the finding changed, the first one first. */
  changed: string[]
  /** It was 「待确认」 before and has been verified: tagged 已证实. */
  promoted: boolean
  /** Faded: the reader has been past it. */
  read?: boolean
  minor?: boolean
  /** Called when the card has been in the viewport and left it; without it, the card is never marked read by being seen. */
  onRead?: (id: Id) => void
}

export function FindingCard({ finding, product, trackName, sources, changed, promoted, read = false, minor, onRead }: FindingCardProps): ReactNode {
  const { t, navigate } = useShell()
  const card = useRef<HTMLElement>(null)
  useLeaveViewport(card, read || !onRead, () => { onRead?.(finding.id) })
  const { ask, asking, problem } = useFollowup(finding.id)

  const unconfirmed = finding.status === 'unconfirmed'
  const unproven = finding.status === 'unproven'
  // A chip that says 原文打不开 already tells it; the finding says it only when none does.
  const sayUnopened = (unconfirmed || unproven) && finding.statusNote === UNOPENED && !sources.some(source => source.openedVia === 'unopened')
  const plainNote = (unconfirmed || unproven) && finding.statusNote !== null && finding.statusNote !== UNOPENED ? finding.statusNote : null
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
      {(unconfirmed || unproven) && <span className="op-card-status">
        {unconfirmed ? <Tag kind="unconfirmed" /> : <span className="op-card-unproven">{t('feed.unproven')}</span>}
        {sayUnopened && <Tag kind="unopened" />}{plainNote && <span className="op-card-note">{plainNote}</span>}
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
