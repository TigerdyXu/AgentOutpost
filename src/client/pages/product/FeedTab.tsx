/**
 * 动态 (design §5.4): every finding of the product, newest first, as the brief's cards. The ones that went unproven (still
 * short of a second source after the waiting time) are folded under one row of their own.
 */
import { useState, type ReactNode } from 'react'
import type { Dimension, DimensionKey, Finding, Id, Product, Source } from '../../../core/types.ts'
import { PROMOTED } from '../../notes.ts'
import { useShell } from '../../shell/context.ts'
import { FindingCard } from '../../ui/FindingCard.tsx'
import { ChevronIcon } from '../../ui/icons.tsx'
import { labelOf } from '../../words.ts'

/** Newest first; one with no readable time goes last. */
const byNewest = (a: Finding, b: Finding) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)

export function FeedTab({ product, findings, sources, dimensions, changed = {} }: {
  product: Product; findings: Finding[]; sources: Source[]; dimensions: Dimension[]
  /** The dimensions each finding changed (from the API); a finding absent changed none. */
  changed?: Record<Id, DimensionKey[]>
}): ReactNode {
  const { t, state } = useShell()
  const [open, setOpen] = useState(false)
  // Every track the product is in, in the track list's order, as the unfiltered brief names them.
  const trackName = state?.tracks.filter(view => view.products.some(item => item.product.id === product.id)).map(view => view.track.name).join(t('today.list')) || undefined
  const labels = new Map(dimensions.map(dimension => [dimension.key, labelOf(t, dimension)] as const))
  const known = new Map(sources.map(source => [source.id, source] as const))

  const sorted = [...findings].sort(byNewest)
  const shown = sorted.filter(finding => finding.status !== 'unproven')
  const unproven = sorted.filter(finding => finding.status === 'unproven')
  const card = (finding: Finding): ReactNode => <FindingCard key={finding.id} finding={finding} product={product} trackName={trackName}
    sources={finding.sourceIds.flatMap(id => known.get(id) ?? [])}
    // Only what the check verified went into the profile (design §8), and only where a card took a version resting on it.
    // A dimension that no track of the product lists is not on the profile: not named, and not what 看改动 opens.
    changed={finding.status === 'verified' ? (changed[finding.id] ?? []).flatMap(key => labels.has(key) ? [{ key, label: labels.get(key)! }] : []) : []}
    promoted={finding.status === 'verified' && finding.statusNote === PROMOTED} />

  if (shown.length === 0 && unproven.length === 0) return <p className="op-day-empty">{t('feed.empty')}</p>
  return <div className="op-feed">
    {shown.length > 0 && <div className="op-cards">{shown.map(card)}</div>}
    {unproven.length > 0 && <>
      <button type="button" className="op-fold" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <ChevronIcon size={14} />
        <span>{open ? t('feed.expiredHide') : t('feed.expired', { count: unproven.length })}</span>
      </button>
      {open && <div className="op-cards">{unproven.map(card)}</div>}
    </>}
  </div>
}
