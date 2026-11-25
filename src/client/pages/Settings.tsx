/**
 * 设置 (design §5.7): where the browser fallback stands, and the plugin's configuration. The form (`SettingsForm`) is the
 * one DSH's Plugin Manager shows on the plugin's row page too, so it needs only DSH's configuration form and the words,
 * not the panel's shell. It edits the volatile fields through DSH (`ConfigForm.mutate`, fenced by the revision the edit
 * began from); where DSH offers no writable form it shows the same values, read-only, and says where to change them.
 */
import { useCallback, useId, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import type { ConfigPageForm } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { OutpostKey, T } from '../locales.ts'
import { useShell } from '../shell/context.ts'
import { CheckIcon } from '../ui/icons.tsx'

/** `ConfigForm.mutate`'s operations. */
type Op = Parameters<ConfigPageForm['mutate']>[0][number]

/**
 * DSH's configuration form of the plugin's entry as a page uses it: the latest snapshot (the page renders again when it
 * changes) and `mutate`; undefined without a form (DSH has none for the entry, or no snapshot of it yet).
 */
export function usePageForm(form: ConfigForm<Record<string, unknown>> | undefined): ConfigPageForm | undefined {
  const subscribe = useCallback((listener: () => void) => form ? form.subscribe(listener) : () => {}, [form])
  const state = useSyncExternalStore(subscribe, () => form?.getSnapshot())
  return useMemo(() => form && state ? { state, mutate: form.mutate.bind(form) } : undefined, [form, state])
}

// ---- the fields, as text the reader edits ----

interface Fields {
  runTime: string
  maxParallel: string
  dailyBudgetYuan: string
  sessionTimeoutMin: string
  provider: string
  modelName: string
  inputPerMTok: string
  outputPerMTok: string
  cacheReadPerMTok: string
}
type Key = keyof Fields

const RUN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const MAX_PARALLEL = { min: 1, max: 8 }
const PRICES = ['inputPerMTok', 'outputPerMTok', 'cacheReadPerMTok'] as const

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const textOf = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? String(value) : ''
/** A plain non-negative decimal, else NaN (no signs, exponents, spaces or empty text). */
const numberOf = (value: string) => /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : NaN

/** The fields of what DSH holds (the section of the plugin's Config); a field it lacks reads empty. */
function fieldsOf(value: Record<string, unknown> | undefined): Fields {
  const prices = isRecord(value?.prices) ? value.prices : {}
  const model = isRecord(value?.model) ? value.model : {}
  return {
    runTime: textOf(value?.runTime), maxParallel: textOf(value?.maxParallel), dailyBudgetYuan: textOf(value?.dailyBudgetYuan),
    sessionTimeoutMin: textOf(value?.sessionTimeoutMin), provider: textOf(model.provider), modelName: textOf(model.model),
    inputPerMTok: textOf(prices.inputPerMTok), outputPerMTok: textOf(prices.outputPerMTok), cacheReadPerMTok: textOf(prices.cacheReadPerMTok),
  }
}

/** What is wrong with each field of `fields`, as the key of the sentence that says so; nothing for a good one. */
function problemsOf(fields: Fields): Partial<Record<Key, OutpostKey>> {
  const problems: Partial<Record<Key, OutpostKey>> = {}
  if (!RUN_TIME.test(fields.runTime.trim())) problems.runTime = 'settings.runTimeInvalid'
  const parallel = numberOf(fields.maxParallel)
  if (!(Number.isInteger(parallel) && parallel >= MAX_PARALLEL.min && parallel <= MAX_PARALLEL.max)) problems.maxParallel = 'settings.maxParallelInvalid'
  if (!(numberOf(fields.dailyBudgetYuan) >= 0)) problems.dailyBudgetYuan = 'settings.budgetInvalid'
  if (!(numberOf(fields.sessionTimeoutMin) >= 1)) problems.sessionTimeoutMin = 'settings.timeoutInvalid'
  if ((fields.provider.trim() === '') !== (fields.modelName.trim() === '')) problems.modelName = 'settings.modelBoth'
  for (const key of PRICES) if (!(numberOf(fields[key]) >= 0)) problems[key] = 'settings.budgetInvalid'
  return problems
}

/** Whether `value` is the same thing as `saved` for `key`: numbers by value (2 and 2.0), text without its edges. */
const same = (key: Key, value: string, saved: string) =>
  key === 'runTime' || key === 'provider' || key === 'modelName' ? value.trim() === saved.trim() : numberOf(value) === numberOf(saved) || value.trim() === saved.trim()

/** The writes that turn `saved` into `values` (only the fields in `edited`), assuming `values` has no problem. */
function opsOf(saved: Fields, values: Fields, edited: readonly Key[]): Op[] {
  const changed = (key: Key) => edited.includes(key) && !same(key, values[key], saved[key])
  const ops: Op[] = []
  if (changed('runTime')) ops.push({ op: 'set', path: ['runTime'], value: values.runTime.trim() })
  for (const key of ['maxParallel', 'dailyBudgetYuan', 'sessionTimeoutMin'] as const) {
    if (changed(key)) ops.push({ op: 'set', path: [key], value: Number(values[key]) })
  }
  if (changed('provider') || changed('modelName')) {
    // Both empty: no model of its own, so the override goes and DSH's default model stands. Else both are there.
    if (values.provider.trim() === '') ops.push({ op: 'unset', path: ['model'] })
    else ops.push({ op: 'set', path: ['model'], value: { provider: values.provider.trim(), model: values.modelName.trim() } })
  }
  // The prices are one object in the Config: written whole when any of them changed.
  if (PRICES.some(changed)) ops.push({ op: 'set', path: ['prices'], value: Object.fromEntries(PRICES.map(key => [key, Number(values[key])])) })
  return ops
}

// ---- the form ----

/** One labelled text field; its problem replaces its hint, and a unit sits at its end. */
function TextField({ label, hint, unit, value, problem, disabled, inputMode, onChange }: {
  label: string; hint?: string; unit?: string; value: string; problem?: string; disabled: boolean; inputMode?: 'numeric' | 'decimal'; onChange: (value: string) => void
}): ReactNode {
  const id = useId()
  const note = problem ?? hint
  return <div className="op-set-field">
    <label className="op-set-label" htmlFor={id}>{label}</label>
    <div className="op-set-control">
      <input id={id} className="op-input" type="text" inputMode={inputMode} autoComplete="off" spellCheck={false} value={value} disabled={disabled}
        aria-invalid={problem ? true : undefined} aria-describedby={note ? `${id}-note` : undefined} onChange={event => { onChange(event.target.value) }} />
      {unit && <span className="op-unit">{unit}</span>}
    </div>
    {note && <p id={`${id}-note`} className={problem ? 'op-set-error' : 'op-set-hint'}>{note}</p>}
  </div>
}

function Section({ title, tag, hint, children }: { title: string; tag?: string; hint?: string; children: ReactNode }): ReactNode {
  return <section className="op-set-section">
    <header className="op-set-head">
      <h2 className="op-set-title">{title}</h2>
      {tag && <span className="op-set-tag">{tag}</span>}
    </header>
    {hint && <p className="op-set-hint">{hint}</p>}
    {children}
  </section>
}

/** The values as text, when they cannot be edited: one row per setting. */
function ReadOnly({ t, values }: { t: T; values: Partial<Fields> }): ReactNode {
  const row = (key: string, label: string, value: string | undefined) => <div key={key} className="op-setting" data-key={key}>
    <dt className="op-setting-label">{label}</dt>
    <dd className="op-setting-value">{value || t('runs.none')}</dd>
  </div>
  const model = values.provider || values.modelName ? [values.provider, values.modelName].filter(Boolean).join(' / ') : t('settings.modelDefault')
  const priced = (value: string | undefined) => value ? t('settings.price', { amount: value }) : undefined
  return <>
    <Section title={t('settings.section.daily')}>
      <dl className="op-settings-list">
        {row('runTime', t('settings.runTime'), values.runTime)}
        {row('maxParallel', t('settings.maxParallel'), values.maxParallel)}
        {row('dailyBudgetYuan', t('settings.budget'), values.dailyBudgetYuan ? t('settings.yuan', { amount: values.dailyBudgetYuan }) : undefined)}
        {row('sessionTimeoutMin', t('settings.timeout'), values.sessionTimeoutMin ? t('settings.minutes', { count: values.sessionTimeoutMin }) : undefined)}
      </dl>
    </Section>
    <Section title={t('settings.section.model')}>
      <dl className="op-settings-list">{row('model', t('settings.section.model'), model)}</dl>
    </Section>
    <Section title={t('settings.section.prices')} tag={t('settings.estimateOnly')}>
      <dl className="op-settings-list">
        {row('inputPerMTok', t('settings.priceInput'), priced(values.inputPerMTok))}
        {row('outputPerMTok', t('settings.priceOutput'), priced(values.outputPerMTok))}
        {row('cacheReadPerMTok', t('settings.priceCached'), priced(values.cacheReadPerMTok))}
      </dl>
    </Section>
  </>
}

type Notice = { kind: 'saved' } | { kind: 'problem'; text: string }

/**
 * The editable fields with their save bar. Only the fields the reader touched are kept (`edits`), over what DSH holds
 * now, so a field changed elsewhere meanwhile is not written back with an old value.
 */
function Editable({ t, form }: { t: T; form: ConfigPageForm }): ReactNode {
  const saved = fieldsOf(form.state.value)
  const [edits, setEdits] = useState<Partial<Fields>>({})
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  /** The revision the edit began from, which fences the write; undefined after a refusal (DSH's latest then). */
  const fence = useRef<number | undefined>(undefined)

  const values: Fields = { ...saved, ...edits }
  const edited = (Object.keys(edits) as Key[]).filter(key => !same(key, values[key], saved[key]))
  const dirty = edited.length > 0
  const problems = dirty ? problemsOf(values) : {}
  const valid = Object.keys(problems).length === 0
  const edit = (key: Key, value: string) => {
    if (Object.keys(edits).length === 0) fence.current = form.state.revision
    setEdits(previous => ({ ...previous, [key]: value }))
    setNotice(null)
  }
  const revert = () => { setEdits({}); setNotice(null) }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!dirty || !valid || saving) return
    const ops = opsOf(saved, values, edited)
    if (ops.length === 0) { revert(); return }
    setSaving(true)
    setNotice(null)
    try {
      if (await form.mutate(ops, fence.current)) {
        setEdits({})
        setNotice({ kind: 'saved' })
      } else {
        fence.current = undefined
        setNotice({ kind: 'problem', text: t('settings.refused') })
      }
    } catch (error) {
      setNotice({ kind: 'problem', text: t('settings.failed', { reason: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setSaving(false)
    }
  }

  const field = (key: Key, label: string, extra: { hint?: string; unit?: string; inputMode?: 'numeric' | 'decimal' } = {}) => {
    const problem = problems[key]
    return <TextField label={label} value={values[key]} disabled={saving} {...problem ? { problem: t(problem) } : {}} {...extra} onChange={value => { edit(key, value) }} />
  }
  return <form className="op-settings-form" noValidate onSubmit={event => { void save(event) }}>
    <p className="op-settings-intro">{t('settings.intro')}</p>
    <Section title={t('settings.section.daily')}>
      <div className="op-set-grid">
        {field('runTime', t('settings.runTime'), { hint: t('settings.runTimeHint') })}
        {field('maxParallel', t('settings.maxParallel'), { hint: t('settings.maxParallelHint'), inputMode: 'numeric' })}
        {field('dailyBudgetYuan', t('settings.budget'), { hint: t('settings.budgetHint'), inputMode: 'decimal' })}
        {field('sessionTimeoutMin', t('settings.timeout'), { hint: t('settings.timeoutHint'), inputMode: 'decimal' })}
      </div>
    </Section>
    <Section title={t('settings.section.model')} hint={t('settings.modelHint')}>
      <div className="op-set-grid" data-wide="">
        {field('provider', t('settings.provider'))}
        {field('modelName', t('settings.modelName'))}
      </div>
    </Section>
    <Section title={t('settings.section.prices')} tag={t('settings.estimateOnly')} hint={t('settings.pricesHint')}>
      <div className="op-set-grid" data-wide="">
        {field('inputPerMTok', t('settings.priceInput'), { unit: t('settings.unit'), inputMode: 'decimal' })}
        {field('outputPerMTok', t('settings.priceOutput'), { unit: t('settings.unit'), inputMode: 'decimal' })}
        {field('cacheReadPerMTok', t('settings.priceCached'), { unit: t('settings.unit'), inputMode: 'decimal' })}
      </div>
    </Section>
    <div className="op-save-bar">
      <div className="op-save-text">
        {notice?.kind === 'problem' ? <p className="op-save-problem" role="alert">{notice.text}</p>
          : <p className="op-save-status" aria-live="polite">{saving ? t('settings.saving') : notice?.kind === 'saved' ? t('settings.saved') : ''}</p>}
      </div>
      <button type="button" className="op-button" disabled={!dirty || saving} onClick={revert}>{t('settings.revert')}</button>
      <button type="submit" className="op-button" data-variant="primary" disabled={!dirty || !valid || saving}>{t('settings.save')}</button>
    </div>
  </form>
}

/**
 * The configuration form of the plugin, as the panel's 设置 page and the Plugin Manager's row page show it. `form` is DSH's
 * (editable while its snapshot is ready and writable; else the values are only shown, with where to change them); `known`
 * is what the caller can tell from `GET state`: the data directory (DSH's form carries only the fields that can change
 * while Outpost runs, which it is not) and the run time, shown while DSH has not answered.
 */
export function SettingsForm({ t, form, known }: { t: T; form: ConfigPageForm | undefined; known?: { runTime?: string; dataDir?: string } }): ReactNode {
  const snapshot = form?.state
  const editable = form !== undefined && snapshot?.status === 'ready' && snapshot.writable ? form : undefined
  const value = snapshot?.status === 'ready' ? snapshot.value : undefined
  const dataDir = known?.dataDir || textOf(value?.dataDir)
  return <div className="op-settings-body">
    {editable ? <Editable t={t} form={editable} /> : <>
      <p className="op-settings-note">{snapshot?.status === 'loading' ? t('settings.loading') : t('settings.readOnly')}</p>
      <ReadOnly t={t} values={value ? fieldsOf(value) : { runTime: known?.runTime }} />
    </>}
    <Section title={t('settings.section.data')} hint={t('settings.dataHint')}>
      <p className="op-datadir">{dataDir || t('runs.none')}</p>
    </Section>
  </div>
}

/** The browser fallback's standing: when it is off, why that matters and how to turn it on. */
function BrowserFallback({ t, available }: { t: T; available: boolean }): ReactNode {
  return <section className="op-browser" data-on={available ? '' : undefined} role="status">
    {available && <CheckIcon size={16} />}
    <span>{t(available ? 'settings.browser.on' : 'settings.browser.off')}</span>
  </section>
}

export function Settings(): ReactNode {
  const { t, state, configForm } = useShell()
  return <div className="op-page op-settings">
    <h1 className="op-page-title">{t('nav.settings')}</h1>
    {state && <BrowserFallback t={t} available={state.browserAvailable} />}
    <SettingsForm t={t} form={configForm} {...state ? { known: { runTime: state.runTime, dataDir: state.dataDir } } : {}} />
  </div>
}
