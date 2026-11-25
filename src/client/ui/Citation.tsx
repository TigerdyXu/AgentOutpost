/**
 * A citation `[n]` in a card's text (design §5.4): hovering or focusing it shows the source's title, publisher, date and
 * the sentence quoted from it; a click opens the original page in a new window.
 */
import { useId, useRef, useState, type ReactNode } from 'react'
import type { Source } from '../../core/types.ts'
import { useShell } from '../shell/context.ts'

/** Width of the card, as in the stylesheet, and the margin it keeps from the content's right edge. */
const CARD_WIDTH = 320
const EDGE = 16

export function Citation({ n, source }: { n: number; source: Source | undefined }): ReactNode {
  const { t } = useShell()
  const id = useId()
  const anchor = useRef<HTMLAnchorElement>(null)
  const [open, setOpen] = useState<false | 'start' | 'end'>(false)
  if (!source) return <sup className="op-cite">[{n}]</sup>
  /** Opens the card, toward the left when there is no room for it on the right of the anchor. */
  const show = () => {
    const box = anchor.current?.getBoundingClientRect()
    const room = anchor.current?.closest('.op-content')?.getBoundingClientRect().right ?? document.documentElement.clientWidth
    setOpen(box && room > 0 && box.left + CARD_WIDTH + EDGE > room ? 'end' : 'start')
  }
  const hide = () => { setOpen(false) }
  const meta = [source.publisher, source.publishedAt?.slice(0, 10)].filter(Boolean).join(' · ')
  return <sup className="op-cite">
    <a ref={anchor} href={source.url} target="_blank" rel="noopener noreferrer" aria-label={t('source.open', { title: source.title })}
      aria-describedby={open ? id : undefined} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>[{n}]</a>
    {open && <span className="op-cite-card" id={id} role="tooltip" data-align={open}>
      <span className="op-cite-title">{source.title}</span>
      {meta && <span className="op-cite-meta">{meta}</span>}
      {source.quote && <span className="op-cite-quote">「{source.quote}」</span>}
    </span>}
  </sup>
}
