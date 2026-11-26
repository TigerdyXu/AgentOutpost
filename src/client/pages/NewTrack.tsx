/**
 * 新建赛道 (design §5.3, mockup 3 option B): three steps in the right column. Step 1 is a short form (name, one sentence,
 * the six default dimensions and any the user adds); sent, it folds into a summary block with 「改」. Step 2 is the picking
 * page: the AI's candidates arrive one by one in a grid that fills the width, in groups (强烈推荐 picked by default, 可以考虑
 * compact, 没推荐的 folded with why), with a one-sentence adjustment box and a sticky footer (how many, what it costs a day,
 * how long the first profiles take). 「开始跟踪」 starts the profiles and opens the first product. Step 3 shows in the middle
 * column and on the product pages.
 *
 * The page is the route's `trackId`: with none it is the form; with one it is that track's picking page, which can be left
 * and come back to (a running recommendation goes on in the host; the picks are kept in memory for the session).
 */
import { useEffect, useId, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { DEFAULT_DIMENSIONS } from '../../core/dimensions.ts'
import type { Candidate, Heat, Id, Track } from '../../core/types.ts'
import type { CandidatesView, RunRow } from '../../host/api.ts'
import { call, describeError, useCandidates } from '../api.ts'
import { yuan } from '../shell/MiddleColumn.tsx'
import { useShell } from '../shell/context.ts'
import { duration } from '../time.ts'
import { CheckIcon, ChevronIcon } from '../ui/icons.tsx'
import { ProductIcon } from '../ui/ProductIcon.tsx'

// Limits the host checks (src/host/api.ts): a longer text is a 400 there.
const MAX_NAME = 20
const MAX_BRIEF = 100
const MAX_REFINE = 60
const MAX_DIMENSION_LABEL = 20
const MAX_EXTRA_DIMENSIONS = 14

/** What a product's first profile takes: about 5 minutes, and 3 products at a time (the default of 同时跑几个产品). */
const BASELINE_MINUTES = 5
const BASELINE_PARALLEL = 3
/** Without a daily run to learn from, a product costs ¥0.5 to ¥1.0 a day; with one, the estimate is its mean within 30%. */
const FALLBACK_YUAN: readonly [number, number] = [0.5, 1.0]
const SPREAD = 0.3
const COST_DAYS = 7

const errorOf = (failure: unknown) => failure instanceof Error ? failure : new Error(String(failure))
/** Two labels are one dimension when they differ in case or width only (as the host reads them). */
const sameLabel = (label: string) => label.normalize('NFKC').trim().toLowerCase()
const DEFAULT_LABELS = DEFAULT_DIMENSIONS.map(dimension => dimension.label)
const DEFAULT_KEYS = new Set(DEFAULT_DIMENSIONS.map(dimension => dimension.key))

// ---- what was picked, kept while the panel stays open ----

/**
 * The user's ticks of a track's candidates (id → picked or not), over the host's defaults. A new batch has new candidate
 * ids, so it starts from the defaults on its own.
 */
type Choice = Readonly<Record<Id, boolean>>
const remembered = new Map<Id, Choice>()
/** Forgets every pick kept in memory (for a test that starts clean). */
export function forgetPicks(): void { remembered.clear() }

// ---- the three steps ----

function Steps({ current, minutes }: { current: 1 | 2; minutes: number | null }): ReactNode {
  const { t } = useShell()
  const steps = [t('new.step1'), t('new.step2'), minutes === null ? t('new.step3') : t('new.step3Minutes', { minutes })]
  return <ol className="op-steps" aria-label={t('new.steps')}>
    {steps.map((label, i) => {
      const number = i + 1
      const state = number < current ? 'done' : number === current ? 'current' : 'todo'
      return <li key={label} className="op-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
        <span className="op-step-dot" aria-hidden="true">{state === 'done' && <CheckIcon size={12} />}</span>
        {label}
      </li>
    })}
  </ol>
}

// ---- step 1 ----

interface FormValue { name: string; brief: string; extra: string[] }

/** The custom dimension labels of a track: those that are not one of the six defaults. */
const extraLabels = (track: Track) => track.dimensions.filter(dimension => !DEFAULT_KEYS.has(dimension.key)).map(dimension => dimension.label)

/** The form of step 1, to create a track and to change it: name, one sentence, and the dimensions. */
function TrackForm({ initial, submitLabel, busyLabel, busy, problem, hint, onSubmit, onCancel }: {
  initial: FormValue; submitLabel: string; busyLabel: string; busy: boolean; problem: string | null; hint?: string
  onSubmit: (value: FormValue) => void; onCancel?: () => void
}): ReactNode {
  const { t } = useShell()
  const ids = useId()
  const [name, setName] = useState(initial.name)
  const [brief, setBrief] = useState(initial.brief)
  const [extra, setExtra] = useState(initial.extra)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  /** The custom labels with the draft added, unless it is empty, already there, or one too many. */
  const withDraft = () => {
    const label = draft.trim()
    const known = new Set([...DEFAULT_LABELS, ...extra].map(sameLabel))
    return label && !known.has(sameLabel(label)) && extra.length < MAX_EXTRA_DIMENSIONS ? [...extra, label] : extra
  }
  const addDimension = () => {
    setExtra(withDraft())
    setDraft('')
    setAdding(false)
  }
  const valid = name.trim() !== ''
  // A label typed but not added yet goes along with the form: sending it must not drop it silently.
  const send = (event: FormEvent) => {
    event.preventDefault()
    if (valid && !busy) onSubmit({ name: name.trim(), brief: brief.trim(), extra: withDraft() })
  }

  return <form className="op-track-form" onSubmit={send}>
    <div className="op-field">
      <div className="op-field-head">
        <label htmlFor={`${ids}-name`}>{t('new.name')}</label>
        <span className="op-field-count">{t('new.count', { count: name.length, max: MAX_NAME })}</span>
      </div>
      <input id={`${ids}-name`} name="name" className="op-input" value={name} maxLength={MAX_NAME} autoComplete="off"
        placeholder={t('new.namePlaceholder')} onChange={event => { setName(event.target.value) }} />
    </div>
    <div className="op-field">
      <div className="op-field-head">
        <label htmlFor={`${ids}-brief`}>{t('new.focus')}</label>
        <span className="op-field-count">{t('new.count', { count: brief.length, max: MAX_BRIEF })}</span>
      </div>
      <textarea id={`${ids}-brief`} name="brief" className="op-input" rows={3} value={brief} maxLength={MAX_BRIEF}
        placeholder={t('new.focusPlaceholder')} onChange={event => { setBrief(event.target.value) }} />
    </div>
    <div className="op-field">
      <div className="op-field-head"><span id={`${ids}-dimensions`}>{t('new.dimensions')}</span></div>
      <div className="op-chips" role="group" aria-labelledby={`${ids}-dimensions`}>
        {DEFAULT_LABELS.map(label => <span key={label} className="op-chip">{label}</span>)}
        {extra.map(label => <span key={label} className="op-chip" data-custom="">
          {label}
          <button type="button" className="op-chip-remove" aria-label={t('new.dimensionRemove', { label })}
            onClick={() => { setExtra(extra.filter(other => other !== label)) }}>×</button>
        </span>)}
        {adding
          ? <span className="op-chip-input">
            <input name="dimension" className="op-input" value={draft} maxLength={MAX_DIMENSION_LABEL} autoFocus autoComplete="off"
              aria-label={t('new.dimensionName')} onChange={event => { setDraft(event.target.value) }}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); addDimension() }
                else if (event.key === 'Escape') { event.preventDefault(); setDraft(''); setAdding(false) }
              }} />
            <button type="button" className="op-button" data-size="small" onClick={addDimension}>{t('new.dimensionAdd')}</button>
          </span>
          : extra.length < MAX_EXTRA_DIMENSIONS && <button type="button" className="op-chip op-chip-add" onClick={() => { setAdding(true) }}>{t('new.addDimension')}</button>}
      </div>
    </div>
    {problem && <p className="op-form-problem" role="alert">{problem}</p>}
    <div className="op-form-actions">
      <button type="submit" className="op-button" data-variant="primary" disabled={!valid || busy}>{busy ? busyLabel : submitLabel}</button>
      {onCancel && <button type="button" className="op-button" onClick={onCancel}>{t('new.cancel')}</button>}
      {hint && <p className="op-form-hint">{hint}</p>}
    </div>
  </form>
}

function CreateTrack(): ReactNode {
  const { t, navigate, refresh } = useShell()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const create = async ({ name, brief, extra }: FormValue) => {
    setBusy(true)
    setProblem(null)
    try {
      const { trackId } = await call('POST tracks', { body: { name, brief, extraDimensions: extra } })
      // The middle column shows the new track at once; this page becomes its picking page.
      refresh()
      navigate({ page: 'newTrack', trackId })
    } catch (failure) {
      setProblem(describeError(t, errorOf(failure)))
    } finally {
      setBusy(false)
    }
  }
  return <div className="op-page op-newtrack">
    <Steps current={1} minutes={null} />
    <h1 className="op-page-title">{t('page.newTrack')}</h1>
    <TrackForm initial={{ name: '', brief: '', extra: [] }} submitLabel={t('new.submit')} busyLabel={t('new.creating')} busy={busy} problem={problem}
      hint={t('new.waitHint')} onSubmit={value => { void create(value) }} />
  </div>
}

/** What step 1 said, as a block with 「改」; 「改」 opens the form again to change it. */
function Summary({ track }: { track: Track }): ReactNode {
  const { t, refresh } = useShell()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const initial: FormValue = { name: track.name, brief: track.brief, extra: extraLabels(track) }
  if (!editing) {
    return <div className="op-track-summary">
      <div className="op-track-summary-body">
        {track.brief && <p className="op-track-brief">{track.brief}</p>}
        <div className="op-chips">
          <span className="op-chips-label">{t('new.following')}</span>
          {track.dimensions.map(dimension => <span key={dimension.key} className="op-chip">{dimension.label}</span>)}
        </div>
      </div>
      <button type="button" className="op-button" data-size="small" onClick={() => { setEditing(true) }}>{t('new.edit')}</button>
    </div>
  }
  const save = async (value: FormValue) => {
    if (value.name === initial.name && value.brief === initial.brief && value.extra.join('\n') === initial.extra.join('\n')) { setEditing(false); return }
    setBusy(true)
    setProblem(null)
    try {
      await call('PATCH tracks/:id', { id: track.id, body: { name: value.name, brief: value.brief, extraDimensions: value.extra } })
      refresh()
      setEditing(false)
    } catch (failure) {
      setProblem(describeError(t, errorOf(failure)))
    } finally {
      setBusy(false)
    }
  }
  return <div className="op-track-summary" data-editing="">
    <TrackForm initial={initial} submitLabel={t('new.save')} busyLabel={t('new.saving')} busy={busy} problem={problem}
      onSubmit={value => { void save(value) }} onCancel={() => { setEditing(false) }} />
  </div>
}

// ---- step 2 ----

/** A candidate with the product it names. */
type Found = CandidatesView['candidates'][number]

/** Mean cost of a product's day from the daily runs that cost something (a product's runs of one day add up), or null with none. */
function meanDayCost(runs: RunRow[]): number | null {
  const days = new Map<string, number>()
  for (const run of runs) {
    if (run.kind !== 'daily' || run.productId === null || !(run.costYuan > 0)) continue
    const key = `${run.productId}|${run.date}`
    days.set(key, (days.get(key) ?? 0) + run.costYuan)
  }
  return days.size === 0 ? null : [...days.values()].reduce((sum, cost) => sum + cost, 0) / days.size
}

/** What a product costs a day by the last week's daily runs; null until they are read, and when there is none (or they cannot be read). */
function useDayCost(): number | null {
  const [cost, setCost] = useState<number | null>(null)
  useEffect(() => {
    let active = true
    call('GET runs', { query: { days: COST_DAYS } }).then(({ runs }) => { if (active) setCost(meanDayCost(runs)) }, () => { /* The standing range then does. */ })
    return () => { active = false }
  }, [])
  return cost
}

/**
 * The heat evidence of a candidate: a small chart of the last five weeks when there are enough dated articles, and the
 * count of every article found (dated or not, of any age: so it says 「找到」, not 「近 30 天」).
 */
function HeatLine({ heat }: { heat: Heat }): ReactNode {
  const { t } = useShell()
  // Bars that are all empty (every article older than five weeks) say nothing, and a trend over them is no trend.
  const bars = heat.showBars && heat.datedWeekly.some(count => count > 0)
  const top = Math.max(...heat.datedWeekly, 1)
  const trend = bars && heat.trend !== 'unknown' ? t(`pick.trend.${heat.trend}`) : null
  return <span className="op-heat">
    {bars && <span className="op-heat-bars" role="img" aria-label={t('pick.heatWeeks', { counts: heat.datedWeekly.join('、') })}>
      {heat.datedWeekly.map((count, i) => <i key={i} data-empty={count === 0 ? '' : undefined} style={{ '--op-bar': count / top } as CSSProperties} />)}
    </span>}
    <span>{t('pick.heatFound', { count: heat.foundCount })}</span>
    {trend && <>{' · '}<span className="op-heat-trend">{trend}</span></>}
  </span>
}

/** One candidate: a card that is its own check box. A product the track already tracks shows so and cannot be picked again. */
function PickCard({ candidate, picked, tracked, compact, onToggle }: {
  candidate: Found; picked: boolean; tracked: boolean; compact: boolean; onToggle: () => void
}): ReactNode {
  const { t } = useShell()
  const { product } = candidate
  const company = [product.company, t(`pick.region.${product.region}`), product.form].filter(Boolean).join(' · ')
  return <label className="op-pick" data-picked={picked ? '' : undefined} data-compact={compact ? '' : undefined} data-tracked={tracked ? '' : undefined}>
    <input type="checkbox" className="op-visually-hidden" aria-label={product.name} checked={picked} disabled={tracked} onChange={onToggle} />
    <span className="op-pick-check" aria-hidden="true">{picked && <CheckIcon size={14} />}</span>
    <span className="op-pick-head">
      <ProductIcon product={product} size={compact ? 26 : 30} />
      <span className="op-pick-titles">
        <span className="op-pick-name">{product.name}</span>
        <span className="op-pick-co">{company}</span>
      </span>
    </span>
    {tracked && <span className="op-pick-tracked">{t('pick.tracked')}</span>}
    {!compact && candidate.oneLiner && <span className="op-pick-one">{candidate.oneLiner}</span>}
    {!compact && <HeatLine heat={candidate.heat} />}
    {candidate.reason && <span className="op-pick-why"><b>{t(compact ? 'pick.whyShort' : 'pick.why')}</b>{candidate.reason}</span>}
  </label>
}

function Picking({ trackId }: { trackId: Id }): ReactNode {
  const { t, state, navigate, refresh, setPicks } = useShell()
  const view = state?.tracks.find(entry => entry.track.id === trackId)
  const { data, error, reload } = useCandidates(trackId)
  const dayCost = useDayCost()
  const [overrides, setOverrides] = useState<Choice>(() => remembered.get(trackId) ?? {})
  const [excludedOpen, setExcludedOpen] = useState(false)
  const [refine, setRefine] = useState('')
  const [busy, setBusy] = useState<'refine' | 'retry' | 'start' | null>(null)
  const [refineProblem, setRefineProblem] = useState<string | null>(null)
  const [startProblem, setStartProblem] = useState<string | null>(null)

  const tracked = new Set(view?.products.map(item => item.product.id))
  const candidates = data?.candidates ?? []
  const strong = candidates.filter(c => c.tier === 'strong')
  const consider = candidates.filter(c => c.tier === 'consider')
  const excluded = candidates.filter(c => c.tier === 'excluded')
  const isTracked = (c: Candidate) => tracked.has(c.productId)
  // The host's defaults (the strong ones), over which the user's own ticks of this batch lie.
  const isPicked = (c: Candidate) => !isTracked(c) && (overrides[c.id] ?? c.selected)
  const chosen = [...strong, ...consider].filter(isPicked)
  const count = chosen.length
  const running = data?.running === true

  // The middle column's 「挑产品 · 已选 n」 follows the picks.
  const loaded = data !== undefined
  useEffect(() => { if (loaded) setPicks(trackId, count) }, [loaded, count, trackId, setPicks])

  const choose = (changes: Record<Id, boolean>) => {
    const next = { ...overrides, ...changes }
    remembered.set(trackId, next)
    setOverrides(next)
  }
  const selectGroup = (group: Found[]) => { choose(Object.fromEntries(group.filter(c => !isTracked(c)).map(c => [c.id, true]))) }

  const sendRefine = async (event: FormEvent) => {
    event.preventDefault()
    const text = refine.trim()
    if (!text || running || busy) return
    setBusy('refine')
    setRefineProblem(null)
    try {
      await call('POST tracks/:id/recommend', { id: trackId, body: { refine: text } })
      setRefine('')
      await reload()
    } catch (failure) {
      setRefineProblem(describeError(t, errorOf(failure)))
      void reload()
    } finally {
      setBusy(null)
    }
  }
  const retry = async () => {
    setBusy('retry')
    setRefineProblem(null)
    try {
      await call('POST tracks/:id/recommend', { id: trackId })
      await reload()
    } catch (failure) {
      setRefineProblem(describeError(t, errorOf(failure)))
      void reload()
    } finally {
      setBusy(null)
    }
  }
  const start = async () => {
    setBusy('start')
    setStartProblem(null)
    try {
      await call('POST tracks/:id/start', { id: trackId, body: { candidateIds: chosen.map(c => c.id) } })
      remembered.delete(trackId)
      refresh()
      navigate({ page: 'product', productId: chosen[0]!.productId, tab: 'dossier' })
    } catch (failure) {
      setStartProblem(describeError(t, errorOf(failure)))
    } finally {
      setBusy(null)
    }
  }

  // What the line above the cards says: still looking, or what was found and how long it took.
  const statusLine = !data ? null
    : data.running ? [t('pick.searching', { count: candidates.length }), t('pick.tookRunning', { time: duration(t, data.elapsedSec) })].join(' · ')
    : candidates.length > 0 ? [t('pick.found', { count: candidates.length }), t('pick.took', { time: duration(t, data.elapsedSec) })].join(' · ')
    : null
  // Why there may be nothing to pick (or a failure after some), from how the round ended.
  const reason = data?.error ?? ''
  const runNote = !data || data.running ? null
    : data.status === 'skipped' ? (reason ? t('pick.skipped', { reason }) : t('pick.skippedNoReason'))
    : data.status === 'failed' ? (reason ? t('pick.failed', { reason }) : t('pick.failedNoReason'))
    : data.batchId === null ? t('pick.neverRan')
    : candidates.length === 0 ? t('pick.none') : null
  const canRetry = data !== undefined && !data.running && (data.status === 'failed' || data.status === 'skipped' || data.batchId === null)

  const fresh = chosen.filter(c => c.product.status === 'candidate' || c.product.status === 'archived').length
  const minutes = fresh === 0 ? null : Math.ceil(fresh / BASELINE_PARALLEL) * BASELINE_MINUTES
  const [low, high] = dayCost === null ? [FALLBACK_YUAN[0] * count, FALLBACK_YUAN[1] * count] : [dayCost * count * (1 - SPREAD), dayCost * count * (1 + SPREAD)]
  const cost = [t('pick.estimate', { low: yuan(low), high: yuan(high) }), ...minutes === null ? [] : [t('pick.build', { minutes })]].join(' · ')

  const grid = (group: Found[], compact: boolean) => <div className="op-pick-grid">
    {group.map(c => <PickCard key={c.id} candidate={c} picked={isPicked(c)} tracked={isTracked(c)} compact={compact}
      onToggle={() => { choose({ [c.id]: !isPicked(c) }) }} />)}
  </div>

  return <div className="op-page op-newtrack">
    <Steps current={2} minutes={minutes} />
    <h1 className="op-page-title">{view?.track.name ?? t('page.newTrack')}</h1>
    {view && <Summary track={view.track} />}
    {error && !data && <p className="op-pick-problem" role="status">{describeError(t, error)}</p>}

    <div className="op-pick-bar">
      {statusLine && <p className="op-pick-status">{running && <span className="op-pulse" aria-hidden="true" />}{statusLine}</p>}
      <form className="op-refine" onSubmit={event => { void sendRefine(event) }}>
        <input name="refine" className="op-input" value={refine} maxLength={MAX_REFINE} autoComplete="off" disabled={running}
          aria-label={t('pick.refineLabel')} placeholder={t('pick.refinePlaceholder')} onChange={event => { setRefine(event.target.value) }} />
        <button type="submit" className="op-button" data-size="small" disabled={running || busy !== null || !refine.trim()}>{t('pick.refineSend')}</button>
      </form>
    </div>
    {running && <p className="op-pick-hint">{t('pick.refineWait')}</p>}
    {refineProblem && <p className="op-pick-problem" role="alert">{refineProblem}</p>}
    {runNote && <div className="op-pick-notice">
      <p className="op-pick-problem" role="status">{runNote}</p>
      {canRetry && <button type="button" className="op-button" data-size="small" disabled={busy !== null} onClick={() => { void retry() }}>{t('pick.retry')}</button>}
    </div>}

    {strong.length > 0 && <section className="op-pick-group">
      <div className="op-pick-group-head">
        <h2 className="op-pick-group-title">{t('pick.strong')}<span className="op-pick-group-n">{strong.length}</span></h2>
        {strong.some(c => !isTracked(c)) && <button type="button" className="op-link" onClick={() => { selectGroup(strong) }}>{t('pick.selectGroup')}</button>}
      </div>
      {grid(strong, false)}
    </section>}
    {consider.length > 0 && <section className="op-pick-group">
      <div className="op-pick-group-head"><h2 className="op-pick-group-title">{t('pick.consider')}<span className="op-pick-group-n">{consider.length}</span></h2></div>
      {grid(consider, true)}
    </section>}
    {excluded.length > 0 && <div className="op-pick-fold">
      <button type="button" className="op-fold" aria-expanded={excludedOpen} onClick={() => { setExcludedOpen(open => !open) }}>
        <ChevronIcon size={14} />
        <span className="op-fold-label">{t('pick.excluded', { count: excluded.length })}</span>
        <span className="op-fold-end">{t(excludedOpen ? 'pick.collapse' : 'pick.expand')}</span>
      </button>
      {excludedOpen && <ul className="op-pick-excluded">
        {excluded.map(c => <li key={c.id}>
          <span className="op-pick-excluded-name">{c.product.name}</span>
          <span className="op-pick-excluded-why">{c.reason}</span>
        </li>)}
      </ul>}
    </div>}

    <div className="op-pick-spacer" />
    <div className="op-pick-foot">
      {startProblem && <p className="op-pick-problem" role="alert">{startProblem}</p>}
      {running && <p className="op-pick-early">{t('pick.early')}</p>}
      <span className="op-pick-count">{t('pick.selected', { count })}</span>
      {count > 0 && <span className="op-pick-cost">{cost}</span>}
      <span className="op-pick-actions">
        <button type="button" className="op-button" onClick={() => { navigate({ page: 'today' }) }}>{t('pick.later')}</button>
        <button type="button" className="op-button" data-variant="primary" disabled={count === 0 || busy !== null} onClick={() => { void start() }}>
          {busy === 'start' ? t('pick.starting') : t('pick.start', { count })}
        </button>
      </span>
    </div>
  </div>
}

/** The page of `newTrack`: the form without a track, the picking page of the route's track with one. */
export function NewTrack(): ReactNode {
  const { route } = useShell()
  const trackId = route.page === 'newTrack' ? route.trackId : undefined
  return trackId ? <Picking key={trackId} trackId={trackId} /> : <CreateTrack />
}
