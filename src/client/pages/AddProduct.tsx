/**
 * 「＋ 添加产品」 (M1.2, design §按名字加 and §再推荐一批): a started track's own page, in the look of 新建赛道, with two
 * sections one above the other. 「知道名字」 adds a product by its name: one Outpost already follows joins at once; any
 * other is first confirmed by a small run (`identify`), whose line says what became of it. 「让前哨再找一轮」 asks for
 * another batch of suggestions, which land under 「候选推荐」 as ever.
 *
 * Nothing here is remembered across visits except what runs in the host: the lines of this page are those of what was
 * sent from it (and of a confirmation still running when it is opened), read again with `GET runs` every 2 seconds while
 * the page is open.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { Id, Product, Track } from '../../core/types.ts'
import type { RunRow, StateView, TrackView } from '../../host/api.ts'
import { ApiError, call, describeError, usePoll } from '../api.ts'
import type { T } from '../locales.ts'
import { useShell } from '../shell/context.ts'
import { ProductIcon } from '../ui/ProductIcon.tsx'

// Limits the host checks (src/host/api.ts): a longer text is a 400 there.
const MAX_NAME = 30
const MAX_URL = 500
const MAX_REFINE = 60

/** How often the runs are read while the page is open. */
const POLL_MS = 2000
/** The runs of the last two days: a confirmation begun just before midnight is still there after it. */
const RUN_DAYS = 2

const errorOf = (failure: unknown) => failure instanceof Error ? failure : new Error(String(failure))
/** Whether `value` is an http or https address, as the host asks of a product's site. */
function isHttp(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
const isActive = (run: RunRow) => run.status === 'queued' || run.status === 'running'

type Shown = Pick<Product, 'id' | 'name' | 'iconPath'>

/** What an attempt came to: the line it says, whether the product is in, and the product when there is one to open. */
interface Outcome { ok: boolean; line: string; product: Shown | null }

/** One thing sent from 「知道名字」, and what it waits for. */
interface Attempt {
  key: string
  /** What the user typed. */
  name: string
  /** The confirmation's run; null for a product that joined at once. */
  runId: Id | null
  /** The track's products when it was sent (by id): one a confirmation settles on that is among them was in already. */
  before: ReadonlyMap<Id, Product>
  /** Known as soon as it is sent for a product that joined at once; otherwise it comes with the run's end. */
  outcome: Outcome | null
}

const snapshotOf = (view: TrackView): ReadonlyMap<Id, Product> => new Map(view.products.map(item => [item.product.id, item.product]))
const productIn = (state: StateView | undefined, id: Id): Product | undefined =>
  state?.tracks.flatMap(view => view.products).find(item => item.product.id === id)?.product
/** The names of the tracks other than `trackId` that hold the product. */
const otherTracks = (state: StateView | undefined, trackId: Id, id: Id): string[] =>
  (state?.tracks ?? []).filter(view => view.track.id !== trackId && view.products.some(item => item.product.id === id)).map(view => view.track.name)

/** The line of a product Outpost followed already, which joined as it is: a paused one stays paused. */
function followedLine(t: T, status: Product['status'], tracks: string[]): string {
  return t(status === 'paused' ? 'add.pausedElsewhere' : 'add.linked', { tracks: tracks.length > 0 ? tracks.join('、') : t('add.otherTracks') })
}

/**
 * What a confirmation that is over came to. The run says whether a product passed (`productId`) or why not (`error`); where
 * it stands says the rest. A product that was in the track when the name was sent changed nothing; a new one is being
 * profiled; one that was followed elsewhere is tracked (or paused) and only tops up what this track adds.
 */
async function conclude(t: T, run: RunRow, attempt: Attempt, track: Track, state: StateView | undefined): Promise<Outcome> {
  if (run.status !== 'done' || run.productId === null) {
    return { ok: false, line: run.error ? t('add.notAdded', { reason: run.error }) : t('add.notAddedNoReason'), product: null }
  }
  const was = attempt.before.get(run.productId)
  if (was) return { ok: true, line: t('add.already', { track: track.name }), product: was }
  let product: Product | undefined
  try {
    product = (await call('GET products/:id', { id: run.productId })).product
  } catch {
    product = productIn(state, run.productId)
  }
  const shown: Shown = product ?? { id: run.productId, name: run.productName ?? attempt.name, iconPath: null }
  const line = product && (product.status === 'tracking' || product.status === 'paused')
    ? followedLine(t, product.status, otherTracks(state, track.id, product.id)) : t('add.building')
  return { ok: true, line, product: shown }
}

/** One line of what was sent: pulsing while it is confirmed, then what came of it, with the product to open when there is one. */
function ResultRow({ attempt, run, track }: { attempt: Attempt; run: RunRow | undefined; track: Track }): ReactNode {
  const { t, state, navigate, refresh } = useShell()
  const [outcome, setOutcome] = useState(attempt.outcome)
  const concluding = useRef(false)
  // The latest state when the run ends, without ending the effect with each reading.
  const latest = useRef(state)
  latest.current = state
  const over = run !== undefined && (run.status === 'done' || run.status === 'failed' || run.status === 'skipped')
  useEffect(() => {
    // Decided once, when the run ends: where the product stands afterwards (a profile that finishes) is not this line's business.
    if (outcome !== null || !run || !over || concluding.current) return
    concluding.current = true
    void conclude(t, run, attempt, track, latest.current).then(done => { setOutcome(done); refresh() })
  }, [outcome, run, over, t, attempt, track, refresh])

  const { product } = outcome ?? { product: null }
  return <li className="op-add-result" data-state={outcome === null ? 'running' : outcome.ok ? 'ok' : 'fail'}>
    <span className="op-add-mark" aria-hidden="true">
      {outcome === null ? <span className="op-pulse" /> : product ? <ProductIcon product={product} size={26} /> : <span className="op-add-x">!</span>}
    </span>
    <span className="op-add-body">
      {product
        ? <button type="button" className="op-link op-add-name" onClick={() => { navigate({ page: 'product', productId: product.id, tab: 'dossier' }) }}>{product.name}</button>
        : <span className="op-add-name">{attempt.name}</span>}
      <span className="op-add-line">{outcome ? outcome.line : t('add.confirming')}</span>
      {outcome === null && <span className="op-add-sub">{t('add.confirmingHint')}</span>}
    </span>
  </li>
}

function AddProductPage({ view }: { view: TrackView }): ReactNode {
  const { t, state, navigate, refresh } = useShell()
  const { track } = view
  const ids = useId()
  const runs = usePoll(() => call('GET runs', { query: { days: RUN_DAYS } }), [], POLL_MS)
  const rows = runs.data?.runs

  // ---- 知道名字 ----
  const [name, setName] = useState('')
  const [site, setSite] = useState('')
  const [problem, setProblem] = useState<{ field: 'name' | 'site' | null; text: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [attempts, setAttempts] = useState<readonly Attempt[]>([])
  const nameBox = useRef<HTMLInputElement>(null)
  const siteBox = useRef<HTMLInputElement>(null)
  const counter = useRef(0)
  const addAttempt = (attempt: Attempt) => {
    setAttempts(previous => attempt.runId !== null && previous.some(other => other.runId === attempt.runId) ? previous : [attempt, ...previous])
  }

  // A confirmation still running when the page is opened is shown too (a second click for its name is answered with the same run).
  useEffect(() => {
    const open = (rows ?? []).filter(run => run.kind === 'identify' && run.trackId === track.id && isActive(run))
    if (open.length === 0) return
    setAttempts(previous => {
      const fresh = open.filter(run => !previous.some(other => other.runId === run.id))
      return fresh.length === 0 ? previous
        : [...fresh.map((run): Attempt => ({ key: run.id, name: run.subject ?? '', runId: run.id, before: snapshotOf(view), outcome: null })), ...previous]
    })
  }, [rows, track.id, view])

  const add = async (event: FormEvent) => {
    event.preventDefault()
    if (adding) return
    const typed = name.trim()
    const official = site.trim()
    if (!typed) { setProblem({ field: 'name', text: t('add.nameRequired') }); nameBox.current?.focus(); return }
    if (official && !isHttp(official)) { setProblem({ field: 'site', text: t('add.urlInvalid') }); siteBox.current?.focus(); return }
    setAdding(true)
    setProblem(null)
    const before = snapshotOf(view)
    try {
      const answer = await call('POST tracks/:id/add-product', { id: track.id, body: official ? { name: typed, officialUrl: official } : { name: typed } })
      if ('runId' in answer) {
        addAttempt({ key: answer.runId, name: typed, runId: answer.runId, before, outcome: null })
        await runs.reload()
      } else {
        // Followed already: it joined without a confirmation, and what it says is known now.
        const known = productIn(state, answer.linked)
        const line = answer.already ? t('add.already', { track: track.name }) : followedLine(t, answer.status, otherTracks(state, track.id, answer.linked))
        counter.current += 1
        addAttempt({
          key: `linked-${counter.current}`, name: typed, runId: null, before,
          outcome: { ok: true, line, product: known ?? { id: answer.linked, name: typed, iconPath: null } },
        })
      }
      setName('')
      setSite('')
      refresh()
    } catch (failure) {
      setProblem({ field: null, text: describeError(t, errorOf(failure)) })
    } finally {
      setAdding(false)
    }
  }

  // ---- 让前哨再找一轮 ----
  const [refine, setRefine] = useState('')
  const [asking, setAsking] = useState(false)
  const [askProblem, setAskProblem] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const [watched, setWatched] = useState<readonly Id[]>([])
  const active = (rows ?? []).filter(run => run.kind === 'recommend' && run.trackId === track.id && isActive(run))
  const searching = asking || view.recommending || active.length > 0

  // The rounds seen running here: how the latest of them ended is told below (a failure of an old one nobody watched is not).
  useEffect(() => {
    if (active.length === 0) return
    setWatched(previous => {
      const fresh = active.map(run => run.id).filter(id => !previous.includes(id))
      return fresh.length === 0 ? previous : [...previous, ...fresh]
    })
    // `active` is read from `rows`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, track.id])
  const lastRound = rows?.find(run => run.id === watched.at(-1))
  const roundNote = searching || !lastRound ? null
    : lastRound.status === 'skipped' ? (lastRound.error ? t('pick.skipped', { reason: lastRound.error }) : t('pick.skippedNoReason'))
    : lastRound.status === 'failed' ? (lastRound.error ? t('pick.failed', { reason: lastRound.error }) : t('pick.failedNoReason'))
    : null

  const ask = async (event: FormEvent) => {
    event.preventDefault()
    if (searching) return
    setAsking(true)
    setAskProblem(null)
    const adjustment = refine.trim()
    let sent = false
    try {
      await call('POST tracks/:id/recommend', { id: track.id, body: adjustment ? { refine: adjustment } : {} })
      sent = true
      setRefine('')
    } catch (failure) {
      // 409: a round is running already. That is the round the user waits for; the words typed stay for the next.
      if (failure instanceof ApiError && failure.status === 409) sent = true
      else setAskProblem(describeError(t, errorOf(failure)))
    }
    if (sent) setAsked(true)
    // Read at once what is running now, so the button does not go back for a moment before the next reading.
    await runs.reload()
    refresh()
    setAsking(false)
  }

  return <div className="op-page op-add">
    <h1 className="op-page-title">{t('add.title', { track: track.name })}</h1>

    <section className="op-add-section" aria-labelledby={`${ids}-byname`}>
      <h2 id={`${ids}-byname`} className="op-add-heading">{t('add.byName')}</h2>
      <p className="op-add-hint">{t('add.byNameHint')}</p>
      <form className="op-add-form op-add-byname" noValidate onSubmit={event => { void add(event) }}>
        <div className="op-field">
          <div className="op-field-head">
            <label htmlFor={`${ids}-name`}>{t('add.name')}</label>
            <span className="op-field-count">{t('new.count', { count: name.length, max: MAX_NAME })}</span>
          </div>
          <input id={`${ids}-name`} ref={nameBox} name="name" className="op-input" value={name} maxLength={MAX_NAME} autoComplete="off" autoFocus
            placeholder={t('add.namePlaceholder')} aria-invalid={problem?.field === 'name' ? true : undefined}
            onChange={event => { setName(event.target.value); setProblem(null) }} />
        </div>
        <div className="op-field">
          <div className="op-field-head"><label htmlFor={`${ids}-site`}>{t('add.url')}</label></div>
          <input id={`${ids}-site`} ref={siteBox} name="officialUrl" type="url" className="op-input" value={site} maxLength={MAX_URL} autoComplete="off"
            placeholder="https://" aria-invalid={problem?.field === 'site' ? true : undefined}
            onChange={event => { setSite(event.target.value); setProblem(null) }} />
        </div>
        {problem && <p className="op-form-problem" role="alert">{problem.text}</p>}
        <div className="op-form-actions">
          <button type="submit" className="op-button" data-variant="primary" disabled={adding}>{adding ? t('add.sending') : t('add.submit')}</button>
        </div>
      </form>
      {attempts.length > 0 && <ul className="op-add-results" aria-live="polite">
        {attempts.map(attempt => <ResultRow key={attempt.key} attempt={attempt} track={track} run={rows?.find(run => run.id === attempt.runId)} />)}
      </ul>}
    </section>

    <section className="op-add-section" aria-labelledby={`${ids}-again`}>
      <h2 id={`${ids}-again`} className="op-add-heading">{t('add.again')}</h2>
      <p className="op-add-hint">{t('add.againHint')}</p>
      <form className="op-add-form op-add-again" onSubmit={event => { void ask(event) }}>
        <div className="op-field">
          <div className="op-field-head">
            <label htmlFor={`${ids}-refine`}>{t('add.refine')}</label>
            <span className="op-field-count">{t('new.count', { count: refine.length, max: MAX_REFINE })}</span>
          </div>
          <input id={`${ids}-refine`} name="refine" className="op-input" value={refine} maxLength={MAX_REFINE} autoComplete="off"
            placeholder={t('add.refinePlaceholder')} onChange={event => { setRefine(event.target.value) }} />
        </div>
        {askProblem && <p className="op-form-problem" role="alert">{askProblem}</p>}
        {roundNote && <p className="op-form-problem" role="status">{roundNote}</p>}
        <div className="op-form-actions">
          <button type="submit" className="op-button" data-variant="primary" disabled={searching}>{searching ? t('add.finding') : t('add.recommend')}</button>
          <span className="op-add-cost">{t('add.recommendCost')}</span>
          {(searching || asked || watched.length > 0) && <button type="button" className="op-link op-add-suggestions"
            onClick={() => { navigate({ page: 'newTrack', trackId: track.id }) }}>{t('add.seeSuggestions')}</button>}
        </div>
      </form>
    </section>
  </div>
}

/** The page of `addProduct`: the route's track, as the state has it (an archived or missing one has no page to add to). */
export function AddProduct(): ReactNode {
  const { route, state, t } = useShell()
  const trackId = route.page === 'addProduct' ? route.trackId : undefined
  const view = state?.tracks.find(entry => entry.track.id === trackId)
  if (!state) return <div className="op-page op-add" />
  if (!view) return <div className="op-page op-add"><p className="op-add-hint">{t('add.notFound')}</p></div>
  return <AddProductPage key={view.track.id} view={view} />
}
