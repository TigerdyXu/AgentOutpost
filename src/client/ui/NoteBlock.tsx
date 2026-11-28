/**
 * The user's own note on a product or a finding (M3.3): shown as their words with the day it was last changed and 「编辑」;
 * edited in place (⌘↩ saves, Esc gives up); saved empty, or 「删除笔记」, it is gone. Research never reads it; search,
 * 追问 and other chats (outpost_lookup) do.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { NOTE_MAX } from '../../core/notes.ts'
import type { Id, Note, NoteKind } from '../../core/types.ts'
import { call, describeError } from '../api.ts'
import { useShell } from '../shell/context.ts'
import { localDay } from '../time.ts'

export interface NoteBlockProps {
  kind: NoteKind
  subjectId: Id
  note: Note | null
  /** Whether it is being written; the owner keeps it (its 「写笔记」 opens it). */
  editing: boolean
  onEditing: (editing: boolean) => void
  /** What was kept (null: erased), once the host has it. */
  onSaved: (note: Note | null) => void
}

export function NoteBlock({ kind, subjectId, note, editing, onEditing, onSaved }: NoteBlockProps): ReactNode {
  const { t } = useShell()
  const ids = useId()
  const [text, setText] = useState(note?.text ?? '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  // Each time it opens, it starts from the note as kept.
  useEffect(() => {
    if (!editing) return
    setText(note?.text ?? '')
    setProblem(null)
    field.current?.focus()
  }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (value: string) => {
    setBusy(true)
    setProblem(null)
    try {
      const { note: kept } = await call('POST notes/:kind/:id', { kind, id: subjectId, body: { text: value } })
      onSaved(kept)
      onEditing(false)
    } catch (failure) {
      setProblem(describeError(t, failure instanceof Error ? failure : new Error(String(failure))))
    } finally {
      setBusy(false)
    }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void save(text) }

  if (editing) {
    const max = NOTE_MAX[kind]
    const length = [...text].length
    return <form className="op-note" data-editing="" onSubmit={submit}>
      <label className="op-note-label" htmlFor={`${ids}-text`}>{t('note.label')}</label>
      <textarea ref={field} id={`${ids}-text`} className="op-input op-note-input" rows={kind === 'product' ? 4 : 2} value={text} maxLength={max}
        placeholder={t(kind === 'product' ? 'note.placeholder.product' : 'note.placeholder.finding')} disabled={busy}
        onChange={event => { setText(event.target.value) }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onEditing(false) }
          else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void save(text) }
        }} />
      <div className="op-note-actions">
        <span className="op-note-count" aria-live="polite">{length}/{max}</span>
        {note && <button type="button" className="op-link" data-tone="danger" disabled={busy} onClick={() => { void save('') }}>{t('note.delete')}</button>}
        <button type="button" className="op-button" disabled={busy} onClick={() => { onEditing(false) }}>{t('note.cancel')}</button>
        <button type="submit" className="op-button" data-variant="primary" disabled={busy || (!text.trim() && !note)}>{t(busy ? 'note.saving' : 'note.save')}</button>
      </div>
      {problem && <p className="op-form-problem" role="alert">{problem}</p>}
    </form>
  }
  if (!note) return null
  return <div className="op-note">
    <div className="op-note-head">
      <span className="op-note-label">{t('note.label')}</span>
      <span className="op-note-date">{(localDay(note.updatedAt) ?? '').slice(5)}</span>
      <button type="button" className="op-link" onClick={() => { onEditing(true) }}>{t('note.edit')}</button>
    </div>
    <p className="op-note-text">{note.text}</p>
  </div>
}
