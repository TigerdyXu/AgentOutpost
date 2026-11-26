/**
 * The 「⋯」 menu of the product's header: pause or resume tracking, the product's own daily budget, and the tracks it is in
 * (移到其他赛道…, 也加到其他赛道…, and 从「X」拿掉 for each of several). A small popover that is opened and closed by its
 * button, closes with Escape (the focus returns to the button), with a click elsewhere and when the focus moves elsewhere,
 * and is walked with the arrow keys. The budget and the choice of a track open inline under their entry; a track is chosen
 * from a list of the menu's own entries, which the arrow keys walk like the others (→ opens it, ← folds it away). A refused
 * change is said inside the menu, which stays open; so is the result of a move or an add.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { Id, Product } from '../../../core/types.ts'
import { describeError } from '../../api.ts'
import { useShell } from '../../shell/context.ts'
import { ChevronIcon } from '../../ui/icons.tsx'

/** What the host takes as a product's daily budget in yuan. */
const MAX_BUDGET = 100_000

export type ProductChange = { status?: 'tracking' | 'paused'; dailyBudgetYuan?: number | null }

/** A track as the menu names it. */
export interface TrackRef { id: Id; name: string }
/** The tracks the product is in, and the others it could be moved or added to (not archived ones). */
export interface ProductTracks { current: TrackRef[]; others: TrackRef[] }
/** A change of the product's tracks: moved from one to another, added to one, or taken out of one. */
export type TrackChange = { kind: 'move'; from: Id; to: Id } | { kind: 'link'; to: Id } | { kind: 'unlink'; from: Id }

/** The two entries that open a list of tracks. */
type Pick = 'move' | 'link'

export interface ProductMenuProps {
  product: Product
  onChange: (change: ProductChange) => Promise<void>
  /** Where the product is, or null when that is not known (the entries about tracks are left out). */
  tracks: ProductTracks | null
  /** Makes the change, and answers how many cards it asked for (0 for taking a product out of a track). */
  onTracks: (change: TrackChange) => Promise<number>
}

export function ProductMenu({ product, onChange, tracks, onTracks }: ProductMenuProps): ReactNode {
  const { t } = useShell()
  const menuId = useId()
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const budgetItem = useRef<HTMLButtonElement>(null)
  const backToItem = useRef(false)
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Which list of tracks is open, what was done last (said until the next thing is tried), and the entry that takes the
  // focus once the list opens or folds: the first track, or the entry that owns the list.
  const [picking, setPicking] = useState<Pick | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const focusNext = useRef<'first' | HTMLElement | null>(null)
  const working = useRef(false)
  // Whether the menu is still open when a change comes back: one closed meanwhile has nothing to say and takes no focus.
  const isOpen = useRef(false)
  isOpen.current = open
  const ids = { move: useId(), link: useId(), list: useId(), note: useId() }
  const entries = { move: useRef<HTMLButtonElement>(null), link: useRef<HTMLButtonElement>(null) }

  const close = (refocus: boolean) => {
    setOpen(false)
    setEditing(false)
    setPicking(null)
    setProblem(null)
    setDone(null)
    if (refocus) button.current?.focus()
  }
  // Leaving the budget editor with 取消 puts the focus back on the entry that opened it.
  useEffect(() => {
    if (!editing && backToItem.current) { backToItem.current = false; budgetItem.current?.focus() }
  }, [editing])
  // An entry that is out of use for want of a choice stays one the arrow keys reach (it says why); a disabled button does not.
  const items = () => [...root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []]
  // The list that opens or folds takes the focus with it, so that it is never lost with the entry it was on.
  useEffect(() => {
    const next = focusNext.current
    focusNext.current = null
    if (next === 'first') root.current?.querySelector<HTMLElement>('[data-list] [role="menuitem"]')?.focus()
    else next?.focus()
  }, [picking])

  // Opening puts the focus on the first entry; a press anywhere else closes it.
  useEffect(() => {
    if (!open) return
    items()[0]?.focus()
    const away = (event: Event) => { if (!root.current?.contains(event.target as Node)) close(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('focusin', away)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('focusin', away) }
  }, [open])

  const onKeyDown = (event: KeyboardEvent) => {
    // Only while the menu is open does Escape belong to it; closed, it goes on to whoever else wants it.
    if (event.key === 'Escape') { if (open) { event.stopPropagation(); close(true) } return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    // The arrows walk the entries; in the budget field they keep their own job (a step up or down).
    const target = event.target as HTMLElement
    if (target.getAttribute('role') !== 'menuitem') return
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { sideways(event, target); return }
    const walk = items()
    if (walk.length === 0) return
    event.preventDefault()
    const at = walk.indexOf(document.activeElement as HTMLElement)
    walk[(at + (event.key === 'ArrowDown' ? 1 : -1) + walk.length) % walk.length]!.focus()
  }

  /** → opens the list of the entry it is on (or goes into it, if open); ← folds the list away from inside it, or from its entry. */
  const sideways = (event: KeyboardEvent, target: HTMLElement) => {
    const entry = target.dataset.pick as Pick | undefined
    const listed = target.closest<HTMLElement>('[data-list]')?.dataset.list as Pick | undefined
    if (event.key === 'ArrowRight' && entry && !target.hasAttribute('aria-disabled')) {
      event.preventDefault()
      if (picking === entry) root.current?.querySelector<HTMLElement>('[data-list] [role="menuitem"]')?.focus()
      else toggle(entry)
    } else if (event.key === 'ArrowLeft' && (listed ?? (entry === picking ? entry : undefined))) {
      event.preventDefault()
      toggle(listed ?? entry!)
    }
  }

  /** Opens the list of tracks under its entry, or folds it away; one list is open at a time. */
  const toggle = (kind: Pick) => {
    if (tracks === null || tracks.others.length === 0) return
    setProblem(null)
    setDone(null)
    focusNext.current = picking === kind ? entries[kind].current : 'first'
    setPicking(picking === kind ? null : kind)
  }

  /** Sends a change; the menu closes once it is done, else says why not. */
  const apply = async (change: ProductChange) => {
    setBusy(true)
    setProblem(null)
    try {
      await onChange(change)
      close(true)
    } catch (error) {
      setProblem(describeError(t, error instanceof Error ? error : new Error(String(error))))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Moves, adds or takes out; the menu says what was done and stays open (taking out has nothing to report: the entry is
   * simply gone, so the menu closes). A refusal is said instead, and the list stays open to pick another track.
   */
  const place = async (change: TrackChange, name: string) => {
    if (working.current) return
    working.current = true
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      const topped = await onTracks(change)
      if (!isOpen.current) return
      if (change.kind === 'unlink') { close(true); return }
      setDone(t(change.kind === 'move' ? 'product.moved' : 'product.added', { track: name }) + (topped > 0 ? t('product.toppedUp', { count: topped }) : ''))
      focusNext.current = entries[change.kind].current
      setPicking(null)
    } catch (error) {
      if (isOpen.current) setProblem(describeError(t, error instanceof Error ? error : new Error(String(error))))
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  const saveBudget = (event: FormEvent) => {
    event.preventDefault()
    const text = value.trim()
    const amount = text === '' ? null : Number(text)
    if (amount !== null && !(Number.isFinite(amount) && amount >= 0 && amount <= MAX_BUDGET)) { setProblem(t('product.budgetInvalid')); return }
    void apply({ dailyBudgetYuan: amount })
  }

  const settled = product.status === 'tracking' || product.status === 'paused'
  const budget = t('product.budgetNow', { value: product.dailyBudgetYuan === null ? t('product.budgetNone') : t('product.budgetAmount', { amount: String(product.dailyBudgetYuan) }) })

  // The tracks: with one, the product can be moved; with several, taken out of one. Where it is not known, nothing is offered.
  const mine = tracks?.current ?? []
  const targets = tracks?.others ?? []
  const nowhere = targets.length === 0
  /** An entry that opens the list of the tracks to go to, and the list under it when open. */
  const pickEntry = (kind: Pick): ReactNode => {
    const open = picking === kind
    return <>
      <button type="button" role="menuitem" className="op-menu-item op-menu-more" ref={entries[kind]} id={ids[kind]} data-pick={kind}
        aria-expanded={open} aria-controls={open ? ids.list : undefined} aria-disabled={nowhere || undefined} aria-describedby={nowhere ? ids.note : undefined}
        onClick={() => { toggle(kind) }}>
        <span>{t(kind === 'move' ? 'product.moveTo' : 'product.addTo')}</span>
        <ChevronIcon size={12} />
      </button>
      {open && <div className="op-menu-list" role="group" id={ids.list} data-list={kind} aria-labelledby={ids[kind]}>
        {targets.map(target => <button key={target.id} type="button" role="menuitem" className="op-menu-item op-menu-option" title={target.name}
          onClick={() => { void place(kind === 'move' ? { kind, from: mine[0]!.id, to: target.id } : { kind, to: target.id }, target.name) }}>{target.name}</button>)}
      </div>}
    </>
  }

  return <div className="op-menu" ref={root} onKeyDown={onKeyDown}>
    <button type="button" ref={button} className="op-button" data-size="small" aria-label={t('product.more')} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} onClick={() => { if (open) close(false); else setOpen(true) }}>⋯</button>
    {open && <div className="op-menu-pop" id={menuId} role="menu" aria-label={t('product.more')} aria-busy={busy || undefined}>
      {settled && <button type="button" role="menuitem" className="op-menu-item" disabled={busy}
        onClick={() => { void apply({ status: product.status === 'paused' ? 'tracking' : 'paused' }) }}>{t(product.status === 'paused' ? 'product.resume' : 'product.pause')}</button>}
      {!editing && <button type="button" role="menuitem" className="op-menu-item" ref={budgetItem}
        onClick={() => { setValue(product.dailyBudgetYuan === null ? '' : String(product.dailyBudgetYuan)); setPicking(null); setEditing(true) }}>{budget}</button>}
      {editing && <form className="op-menu-form" noValidate onSubmit={saveBudget}>
        <label className="op-menu-label">
          <span>{t('product.budget')}</span>
          <input className="op-input" type="number" inputMode="decimal" min={0} max={MAX_BUDGET} step="any" value={value} autoFocus
            aria-label={t('product.budgetField')} onChange={event => { setValue(event.target.value); setProblem(null) }} />
        </label>
        <p className="op-menu-hint">{t('product.budgetHint')}</p>
        <div className="op-menu-actions">
          <button type="button" className="op-button" data-size="small" onClick={() => { backToItem.current = true; setEditing(false); setProblem(null) }}>{t('product.budgetCancel')}</button>
          <button type="submit" className="op-button" data-size="small" data-variant="primary" disabled={busy}>{t('product.budgetSave')}</button>
        </div>
      </form>}
      {mine.length > 0 && <div className="op-menu-tracks" role="none">
        {mine.length === 1 && pickEntry('move')}
        {pickEntry('link')}
        {nowhere && <p className="op-menu-note" id={ids.note}>{t('product.noOtherTrack')}</p>}
        {mine.length > 1 && mine.map(track => <button key={track.id} type="button" role="menuitem" className="op-menu-item" title={track.name}
          onClick={() => { void place({ kind: 'unlink', from: track.id }, track.name) }}>{t('product.remove', { track: track.name })}</button>)}
      </div>}
      {done && <p className="op-menu-done" role="status">{done}</p>}
      {problem && <p className="op-menu-problem" role="alert">{problem}</p>}
    </div>}
  </div>
}
