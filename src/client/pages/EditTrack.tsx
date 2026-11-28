/**
 * 编辑赛道 (M1.5): a track's own settings page, opened from the 「⋯」 beside its name in the middle column. Its name, the
 * sentence of what it follows, and its dimensions (each renamed in place, removed with ×, or added at the end), saved
 * together; then, set apart, deleting the track, which names the products that go with it (those no other track has) and
 * asks once more before it is done.
 *
 * A default dimension under its default name shows in the reader's language (`labelOf`); left as it is, it is sent back
 * under its stored name, so that saving the page in English does not rename it.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { DEFAULT_DIMENSIONS } from '../../core/dimensions.ts'
import type { DimensionKey } from '../../core/types.ts'
import type { TrackView } from '../../host/api.ts'
import { call, describeError } from '../api.ts'
import { useShell } from '../shell/context.ts'
import { counted, labelOf } from '../words.ts'

// Limits the host checks (src/host/api.ts): a longer text, or more dimensions, is a 400 there.
const MAX_NAME = 20
const MAX_BRIEF = 100
const MAX_DIMENSION_LABEL = 20
const MAX_DIMENSIONS = 20

const errorOf = (failure: unknown) => failure instanceof Error ? failure : new Error(String(failure))
/** Two labels are one dimension when they differ in case or width only (as the host reads them). */
const sameLabel = (label: string) => label.normalize('NFKC').trim().toLowerCase()

/** A dimension on the page: one the track has (`key`, with its stored name and the name it was shown under), or a new one. */
interface Row { id: string; key?: DimensionKey; stored?: string; shown?: string; text: string }

export function EditTrack(): ReactNode {
  const { t, route, state } = useShell()
  if (route.page !== 'editTrack' || !state) return null
  const view = state.tracks.find(entry => entry.track.id === route.trackId)
  if (!view) {
    return <div className="op-page op-edit-track">
      <h1 className="op-page-title">{t('track.title')}</h1>
      <p className="op-day-problem" role="alert">{t('track.notFound')}</p>
    </div>
  }
  // Another track is another page: nothing typed for the last one stays.
  return <TrackEditor key={view.track.id} view={view} others={state.tracks.filter(entry => entry.track.id !== view.track.id)} />
}

function TrackEditor({ view, others }: { view: TrackView; others: TrackView[] }): ReactNode {
  const { t, refresh } = useShell()
  const ids = useId()
  const { track } = view
  const [name, setName] = useState(track.name)
  const [brief, setBrief] = useState(track.brief)
  const [rows, setRows] = useState<Row[]>(() => track.dimensions.map(dimension => {
    const shown = labelOf(t, dimension)
    return { id: dimension.key, key: dimension.key, stored: dimension.label, shown, text: shown }
  }))
  const [added, setAdded] = useState(0)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const edit = (id: string, text: string) => { setRows(rows.map(row => row.id === id ? { ...row, text } : row)); setProblem(null); setSaved(null) }
  const removeRow = (id: string) => { setRows(rows.filter(row => row.id !== id)); setProblem(null); setSaved(null) }
  const addRow = () => { setRows([...rows, { id: `new-${added}`, text: '' }]); setAdded(added + 1); setSaved(null) }

  // A default dimension typed under its name in the reader's language is that default (sent under its stored name), so
  // that removing 「Audience」 and typing it back brings its cards back instead of making a new dimension.
  const defaultNamed = new Map(DEFAULT_DIMENSIONS.map(dimension => [sameLabel(labelOf(t, dimension)), dimension.label] as const))
  /** The dimensions as sent: one left under the name it was shown under keeps its stored name (the default one, in Chinese). */
  const toSend = () => rows.map(row => {
    const text = row.text.trim()
    return row.key === undefined ? { label: defaultNamed.get(sameLabel(text)) ?? text }
      : { key: row.key, label: text === row.shown ? row.stored! : defaultNamed.get(sameLabel(text)) ?? text }
  })

  /** Why the page cannot be sent as it is, or null: no dimension, one without a name, or one named twice (as sent). */
  const check = (): string | null => {
    if (rows.length === 0) return t('said.dimensionsNeeded')
    if (rows.some(row => !row.text.trim())) return t('track.dimensionEmpty')
    const seen = new Set<string>()
    for (const [i, dimension] of toSend().entries()) {
      if (seen.has(sameLabel(dimension.label))) return t('said.dimensionTwice', { label: rows[i]!.text.trim() })
      seen.add(sameLabel(dimension.label))
    }
    return null
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || !name.trim()) return
    const refused = check()
    if (refused) { setProblem(refused); return }
    setBusy(true)
    setProblem(null)
    setSaved(null)
    const dimensions = toSend()
    try {
      const answer = await call('PATCH tracks/:id', { id: track.id, body: { name: name.trim(), brief: brief.trim(), dimensions } })
      refresh()
      // The page now shows the track as saved: the new dimensions are its own, under their keys.
      setRows(answer.dimensions.map(dimension => {
        const shown = labelOf(t, dimension)
        return { id: dimension.key, key: dimension.key, stored: dimension.label, shown, text: shown }
      }))
      setSaved(answer.toppedUp > 0 ? counted(t, 'track.toppedUp', { count: answer.toppedUp }) : t('track.saved'))
    } catch (failure) {
      setProblem(describeError(t, errorOf(failure)))
    } finally {
      setBusy(false)
    }
  }

  return <div className="op-page op-edit-track">
    <h1 className="op-page-title">{t('track.title')}</h1>
    <form className="op-track-form" noValidate onSubmit={event => { void save(event) }}>
      <div className="op-field">
        <div className="op-field-head">
          <label htmlFor={`${ids}-name`}>{t('new.name')}</label>
          <span className="op-field-count">{t('new.count', { count: name.length, max: MAX_NAME })}</span>
        </div>
        <input id={`${ids}-name`} className="op-input" value={name} maxLength={MAX_NAME} autoComplete="off"
          onChange={event => { setName(event.target.value); setSaved(null) }} />
      </div>
      <div className="op-field">
        <div className="op-field-head">
          <label htmlFor={`${ids}-brief`}>{t('new.focus')}</label>
          <span className="op-field-count">{t('new.count', { count: brief.length, max: MAX_BRIEF })}</span>
        </div>
        <textarea id={`${ids}-brief`} className="op-input" rows={3} value={brief} maxLength={MAX_BRIEF}
          placeholder={t('new.focusPlaceholder')} onChange={event => { setBrief(event.target.value); setSaved(null) }} />
      </div>
      <div className="op-field">
        <div className="op-field-head"><span id={`${ids}-dimensions`}>{t('track.dimensions')}</span></div>
        <p className="op-set-hint">{t('track.dimensionsHint')}</p>
        <div className="op-dim-list" role="group" aria-labelledby={`${ids}-dimensions`}>
          {rows.map((row, i) => <div key={row.id} className="op-dim-row">
            <input className="op-input" value={row.text} maxLength={MAX_DIMENSION_LABEL} autoComplete="off" autoFocus={row.key === undefined && row.text === ''}
              aria-label={t('track.dimensionLabel', { n: i + 1 })} onChange={event => { edit(row.id, event.target.value) }} />
            <button type="button" className="op-dim-remove" aria-label={t('track.dimensionRemove', { label: row.text.trim() || String(i + 1) })}
              onClick={() => { removeRow(row.id) }}>×</button>
          </div>)}
        </div>
        {rows.length < MAX_DIMENSIONS && <div>
          <button type="button" className="op-chip op-chip-add" onClick={addRow}>{t('track.dimensionAdd')}</button>
        </div>}
      </div>
      {problem && <p className="op-form-problem" role="alert">{problem}</p>}
      <div className="op-form-actions">
        <button type="submit" className="op-button" data-variant="primary" disabled={busy || !name.trim()}>{busy ? t('track.saving') : t('track.save')}</button>
        {saved && <p className="op-form-hint op-form-saved" role="status">{saved}</p>}
      </div>
    </form>
    <DeleteTrack view={view} others={others} />
  </div>
}

/** Deleting the track: what goes with it, and the question asked once more before it is done. */
function DeleteTrack({ view, others }: { view: TrackView; others: TrackView[] }): ReactNode {
  const { t, refresh, navigate } = useShell()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const elsewhere = (productId: string) => others.some(other => other.products.some(item => item.product.id === productId))
  const own = view.products.filter(item => !elsewhere(item.product.id)).map(item => item.product.name)
  const shared = view.products.filter(item => elsewhere(item.product.id)).map(item => item.product.name)
  const list = (names: string[]) => names.join(t('today.list'))

  const remove = async () => {
    setBusy(true)
    setProblem(null)
    try {
      await call('POST tracks/:id/delete', { id: view.track.id })
      refresh()
      navigate({ page: 'today' })
    } catch (failure) {
      setProblem(describeError(t, errorOf(failure)))
      setBusy(false)
    }
  }

  return <section className="op-danger-zone" aria-labelledby="op-delete-track">
    <h2 className="op-zone-title" id="op-delete-track">{t('track.delete')}</h2>
    <p className="op-zone-text">{t('track.deleteIntro')}</p>
    <p className="op-zone-text">{own.length > 0 ? t('track.deleteProducts', { count: own.length, names: list(own) }) : t('track.deleteNone')}</p>
    {shared.length > 0 && <p className="op-zone-text">{t('track.deleteShared', { names: list(shared) })}</p>}
    {problem && <p className="op-form-problem" role="alert">{problem}</p>}
    <div className="op-form-actions">
      {!asking
        ? <button type="button" className="op-button" onClick={() => { setAsking(true) }}>{t('track.deleteStart')}</button>
        : <>
          <button type="button" className="op-button" data-variant="danger" disabled={busy} aria-busy={busy || undefined} onClick={() => { void remove() }}>
            {busy ? t('track.deleting') : t('track.deleteConfirm')}
          </button>
          <button type="button" className="op-button" disabled={busy} autoFocus onClick={() => { setAsking(false); setProblem(null) }}>{t('track.deleteCancel')}</button>
        </>}
    </div>
  </section>
}
