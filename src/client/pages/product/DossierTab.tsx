/**
 * 档案 (design §5.4, mockup 4 option A): the key facts, the positioning sentence, and one card per dimension. A card holds
 * the dimension's conclusions; opened, it takes the whole row: the full text with its citations and sources on the left,
 * how the section changed over time on the right.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import type { CardVersion, DimensionKey, Facts, Source } from '../../../core/types.ts'
import { isFresh } from '../../../core/fresh.ts'
import type { ProductView } from '../../../host/api.ts'
import { useShell } from '../../shell/context.ts'
import { shortDay } from '../../time.ts'
import { SourceChip } from '../../ui/SourceChip.tsx'
import { Tag } from '../../ui/Tag.tsx'
import { RichText } from './richText.tsx'

/** What the strip says of `facts`: five cells, 「—」 for what is not known. */
function FactsStrip({ facts }: { facts: Facts | null }): ReactNode {
  const { t } = useShell()
  const none = t('dossier.fact.none')
  const cells: [string, string][] = [
    [t('dossier.fact.form'), facts?.form.trim() || none],
    [t('dossier.fact.platforms'), facts?.platforms.trim() || none],
    [t('dossier.fact.price'), facts?.price.trim() || none],
    [t('dossier.fact.first'), facts?.firstReleased.trim() || none],
    [t('dossier.fact.rivals'), facts && facts.rivals.length > 0 ? facts.rivals.join(t('today.list')) : none],
  ]
  return <dl className="op-facts">
    {cells.map(([name, value]) => <div key={name} className="op-fact"><dt className="op-fact-k">{name}</dt><dd className="op-fact-v">{value}</dd></div>)}
  </dl>
}

interface CardProps {
  dimension: DimensionKey
  label: string
  /** The newest version, or undefined when the dimension has none. */
  card: CardVersion | undefined
  history: ProductView['history'][string] | undefined
  sources: ReadonlyMap<string, Source>
  open: boolean
  baselining: boolean
  fresh: boolean
  onToggle: () => void
  register: (element: HTMLElement | null) => void
}

function DimensionCard({ dimension, label, card, history, sources, open, baselining, fresh, onToggle, register }: CardProps): ReactNode {
  const { t } = useShell()
  const nameId = useId()
  const toggleId = useId()
  const bodyId = useId()
  if (!card) {
    const state = baselining ? 'baselining' : 'empty'
    return <article ref={register} className="op-dcard" data-dimension={dimension} data-state={state}>
      <header className="op-dcard-head"><h3 className="op-dcard-name">{label}</h3></header>
      <p className="op-dcard-placeholder">{t(baselining ? 'dossier.baselining' : 'dossier.empty')}</p>
    </article>
  }
  const sourceOf = (n: number) => { const id = card.sourceIds[n - 1]; return id === undefined ? undefined : sources.get(id) }
  const cited = card.sourceIds.flatMap(id => sources.get(id) ?? [])
  const versions = [...history ?? []].reverse()
  return <article ref={register} className="op-dcard" data-dimension={dimension} data-state="card" data-expanded={open ? '' : undefined}>
    <header className="op-dcard-head">
      <h3 className="op-dcard-name" id={nameId}>{label}</h3>
      {fresh && <Tag kind="fresh" />}
      <button type="button" className="op-dcard-toggle" id={toggleId} aria-expanded={open} aria-controls={bodyId} aria-labelledby={`${toggleId} ${nameId}`}
        onClick={onToggle}>{t(open ? 'dossier.collapse' : 'dossier.expand')}</button>
    </header>
    <div id={bodyId}>
      {!open && <>
        <ul className="op-dcard-bullets">
          {card.bullets.map((bullet, i) => <li key={i}><RichText text={bullet} sourceOf={sourceOf} /></li>)}
        </ul>
        <p className="op-dcard-count">{t('dossier.sourceCount', { count: card.sourceIds.length })}</p>
      </>}
      {open && <div className="op-dcard-open">
        <div className="op-dcard-main">
          <p className="op-dcard-text"><RichText text={card.body} sourceOf={sourceOf} inference={card.inferenceSpans} added={fresh ? card.addedSpans : []} /></p>
          {cited.length > 0 && <div className="op-dcard-sources" role="group" aria-label={t('dossier.sources')}>
            {card.sourceIds.map((id, i) => { const source = sources.get(id); return source ? <SourceChip key={id} source={source} n={i + 1} /> : null })}
          </div>}
        </div>
        <aside className="op-history">
          <h4 className="op-history-title">{t('dossier.history')}</h4>
          <ol className="op-history-list">
            {versions.map((version, i) => <li key={version.version} className="op-history-item" data-latest={i === 0 ? '' : undefined}>
              <span className="op-history-date">{shortDay(version.createdAt) ?? ''}</span>
              <span className="op-history-dot" aria-hidden="true" />
              <span className="op-history-note">{version.changeNote}</span>
            </li>)}
          </ol>
        </aside>
      </div>}
    </div>
  </article>
}

export interface DossierProps {
  view: ProductView
  expanded: ReadonlySet<DimensionKey>
  onToggle: (key: DimensionKey) => void
  /** The card a link asked for: scrolled to once, when it is open. */
  focus: DimensionKey | undefined
  now: Date
}

export function DossierTab({ view, expanded, onToggle, focus, now }: DossierProps): ReactNode {
  const { t } = useShell()
  const baselining = view.product.status === 'baselining'
  const byDimension = new Map(view.cards.map(card => [card.dimension, card] as const))
  const sources = new Map(view.sources.map(source => [source.id, source] as const))
  // The track's dimensions in its order, then any card the product keeps of a dimension the track no longer lists.
  const rows = [
    ...view.dimensions,
    ...view.cards.filter(card => !view.dimensions.some(d => d.key === card.dimension)).map(card => ({ key: card.dimension, label: card.dimension })),
  ]
  const positioning = byDimension.get('positioning')?.summary.trim()

  const elements = useRef(new Map<DimensionKey, HTMLElement>())
  const scrolled = useRef<DimensionKey | undefined>(undefined)
  const ready = focus !== undefined && byDimension.has(focus) && expanded.has(focus)
  useEffect(() => {
    if (!ready || scrolled.current === focus) return
    scrolled.current = focus
    elements.current.get(focus)?.scrollIntoView?.({ block: 'start' })
  }, [ready, focus])

  return <div className="op-dossier">
    <FactsStrip facts={view.facts} />
    {positioning && <p className="op-positioning">{positioning}</p>}
    {baselining && <div className="op-baseline">
      {view.progress
        ? <>
          <div className="op-baseline-bar" role="progressbar" aria-valuemin={0} aria-valuemax={view.progress.total} aria-valuenow={view.progress.done}
            aria-label={t('dossier.progress', view.progress)}>
            <span style={{ width: `${view.progress.total > 0 ? Math.min(100, Math.round(view.progress.done / view.progress.total * 100)) : 0}%` }} />
          </div>
          <p className="op-baseline-text">{t('dossier.progress', view.progress)}</p>
        </>
        : <p className="op-baseline-text">{t('dossier.progressUnknown')}</p>}
    </div>}
    <div className="op-dgrid" role="group" aria-label={t('dossier.cards')}>
      {rows.map(({ key, label }) => {
        const card = byDimension.get(key)
        return <DimensionCard key={key} dimension={key} label={label} card={card} history={view.history[key]} sources={sources}
          open={card !== undefined && expanded.has(key)} baselining={baselining} fresh={card !== undefined && isFresh(card, now)}
          onToggle={() => { onToggle(key) }} register={element => { if (element) elements.current.set(key, element); else elements.current.delete(key) }} />
      })}
    </div>
  </div>
}
