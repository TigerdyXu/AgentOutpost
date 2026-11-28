/**
 * The user's own note on a product or a finding (M3.3): shown as their words with the day it was last changed and 「编辑」;
 * edited in place (⌘↩ saves, Esc gives up, not while an input method is composing); saved empty, or 「删除笔记」, it is
 * gone. Research never reads it; search, 追问 and other chats (outpost_lookup) do. Focus goes back to 「编辑」 when the
 * box closes on a note, else to the owner's own control (`returnFocus`).
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { NOTE_MAX } from '../../core/notes.ts'
import type { Id, Note, NoteKind } from '../../core/types.ts'
import { call, describeError } from '../api.ts'
import { useShell } from '../shell/context.ts'
import { shortDay } from '../time.ts'

export interface NoteBlockProps {
  kind: NoteKind
  subjectId: Id
  note: Note | null
  /** What it is a note on (a product's name, a finding's headline), for screen readers. */
  about: string
  /** Whether it is being written; the owner keeps it (its 「写笔记」 opens it). */
  editing: boolean
  onEditing: (editing: boolean) => void
  /** What was kept (null: erased), once the host has it. */
  onSaved: (note: Note | null) => void
  /** Where focus goes when the box closes with no note to show (the owner's 「写笔记」). */
  returnFocus?: () => void
}

/** How long a note is, as the host counts it: in characters, an emoji being one. */
const lengthOf = (text: string) => [...text.trim()].length

export function NoteBlock({ kind, subjectId, note, about, editing, onEditing, onSaved, returnFocus }: NoteBlockProps): ReactNode {
  const { t } = useShell()
  const ids = useId()
  const [text, setText] = useState(note?.text ?? '')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const edit = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(editing)
  // Each time it opens, it starts from the note as kept; when it closes, focus goes back where the reader was.
  useEffect(() => {
    if (editing) {
      setText(note?.text ?? '')
      setProblem(null)
      field.current?.focus()
    } else if (wasEditing.current) {
      if (edit.current) edit.current.focus()
      else returnFocus?.()
    }
    wasEditing.current = editing
  }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  const max = NOTE_MAX[kind]
  const length = lengthOf(text)
  const save = async (value: string) => {
    if (lengthOf(value) > max) return
    setBusy(true)
    setProblem(null)
    try {
      const { note: kept } = await call('POST notes/:kind/:id', { kind, id: subjectId, body: { text: value } })
      onSaved(kept)
      onEditing(false)
    } catch (failure) {
      setProblem(describeError(t, failure instanceof Error ? failure : new Error(String(failure))))
      field.current?.focus()
    } finally {
      setBusy(false)
    }
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void save(text) }

  if (editing) {
    const over = length > max
    return <form className="op-note" data-editing="" onSubmit={submit}>
      <label className="op-note-label" htmlFor={`${ids}-text`}>{t('note.label')}</label>
      {/* No maxLength: the browser would count an emoji as two, the host counts it as one; the count says when it is over. */}
      <textarea ref={field} id={`${ids}-text`} className="op-input op-note-input" rows={kind === 'product' ? 4 : 2} value={text}
        aria-describedby={`${ids}-count`} aria-invalid={over || undefined}
        placeholder={t(kind === 'product' ? 'note.placeholder.product' : 'note.placeholder.finding')} readOnly={busy}
        onChange={event => { setText(event.target.value) }}
        onKeyDown={event => {
          // While an input method composes, Esc and Enter are its own (dropping or choosing the candidates).
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onEditing(false) }
          else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(text) }
        }} />
      <div className="op-note-actions">
        <span className="op-note-count" id={`${ids}-count`} data-over={over ? '' : undefined}>{over ? t('note.over', { max }) : `${length}/${max}`}</span>
        {note && <button type="button" className="op-link" data-tone="danger" disabled={busy} onClick={() => { void save('') }}>{t('note.delete')}</button>}
        <button type="button" className="op-button" disabled={busy} onClick={() => { onEditing(false) }}>{t('note.cancel')}</button>
        <button type="submit" className="op-button" data-variant="primary" disabled={busy || over || (!text.trim() && !note)}>{t(busy ? 'note.saving' : 'note.save')}</button>
      </div>
      {problem && <p className="op-form-problem" role="alert">{problem}</p>}
    </form>
  }
  if (!note) return null
  return <div className="op-note">
    <div className="op-note-head">
      <span className="op-note-label">{t('note.label')}</span>
      <span className="op-note-date">{shortDay(note.updatedAt) ?? ''}</span>
      <button ref={edit} type="button" className="op-link" aria-label={t('note.editAbout', { about })} onClick={() => { onEditing(true) }}>{t('note.edit')}</button>
    </div>
    <p className="op-note-text">{note.text}</p>
  </div>
}
