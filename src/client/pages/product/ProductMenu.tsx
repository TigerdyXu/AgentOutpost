/**
 * The 「⋯」 menu of the product's header: pause or resume tracking, and the product's own daily budget. A small popover
 * that is opened and closed by its button, closes with Escape (the focus returns to the button), with a click elsewhere
 * and when the focus moves elsewhere, and is walked with the arrow keys. A refused change is said inside it, which stays open.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import type { Product } from '../../../core/types.ts'
import { describeError } from '../../api.ts'
import { useShell } from '../../shell/context.ts'

/** What the host takes as a product's daily budget in yuan. */
const MAX_BUDGET = 100_000

export type ProductChange = { status?: 'tracking' | 'paused'; dailyBudgetYuan?: number | null }

export function ProductMenu({ product, onChange }: { product: Product; onChange: (change: ProductChange) => Promise<void> }): ReactNode {
  const { t } = useShell()
  const menuId = useId()
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const close = (refocus: boolean) => {
    setOpen(false)
    setEditing(false)
    setProblem(null)
    if (refocus) button.current?.focus()
  }
  const items = () => [...root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []]

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
    if (event.key === 'Escape') { event.stopPropagation(); close(true); return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const entries = items()
    if (entries.length === 0) return
    event.preventDefault()
    const at = entries.indexOf(document.activeElement as HTMLElement)
    entries[(at + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length]!.focus()
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

  const saveBudget = (event: FormEvent) => {
    event.preventDefault()
    const text = value.trim()
    const amount = text === '' ? null : Number(text)
    if (amount !== null && !(Number.isFinite(amount) && amount >= 0 && amount <= MAX_BUDGET)) { setProblem(t('product.budgetInvalid')); return }
    void apply({ dailyBudgetYuan: amount })
  }

  const settled = product.status === 'tracking' || product.status === 'paused'
  const budget = t('product.budgetNow', { value: product.dailyBudgetYuan === null ? t('product.budgetNone') : t('product.budgetAmount', { amount: String(product.dailyBudgetYuan) }) })
  return <div className="op-menu" ref={root} onKeyDown={onKeyDown}>
    <button type="button" ref={button} className="op-button" data-size="small" aria-label={t('product.more')} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} onClick={() => { if (open) close(false); else setOpen(true) }}>⋯</button>
    {open && <div className="op-menu-pop" id={menuId} role="menu" aria-label={t('product.more')}>
      {settled && <button type="button" role="menuitem" className="op-menu-item" disabled={busy}
        onClick={() => { void apply({ status: product.status === 'paused' ? 'tracking' : 'paused' }) }}>{t(product.status === 'paused' ? 'product.resume' : 'product.pause')}</button>}
      {!editing && <button type="button" role="menuitem" className="op-menu-item"
        onClick={() => { setValue(product.dailyBudgetYuan === null ? '' : String(product.dailyBudgetYuan)); setEditing(true) }}>{budget}</button>}
      {editing && <form className="op-menu-form" noValidate onSubmit={saveBudget}>
        <label className="op-menu-label">
          <span>{t('product.budget')}</span>
          <input className="op-input" type="number" inputMode="decimal" min={0} max={MAX_BUDGET} step="any" value={value} autoFocus
            aria-label={t('product.budgetField')} onChange={event => { setValue(event.target.value); setProblem(null) }} />
        </label>
        <p className="op-menu-hint">{t('product.budgetHint')}</p>
        <div className="op-menu-actions">
          <button type="button" className="op-button" data-size="small" onClick={() => { setEditing(false); setProblem(null) }}>{t('product.budgetCancel')}</button>
          <button type="submit" className="op-button" data-size="small" data-variant="primary" disabled={busy}>{t('product.budgetSave')}</button>
        </div>
      </form>}
      {problem && <p className="op-menu-problem" role="alert">{problem}</p>}
    </div>}
  </div>
}
