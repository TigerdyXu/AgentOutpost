/**
 * Baseline (design §7.2): each newly tracked product gets one session 「前哨 · <产品> 建档」 that writes a card for every
 * dimension still without one, and the key facts. Its cards then go through the check (`verifyProduct`, Task 9), and
 * only after that does the product count as tracked. Products run side by side (as many as the runner allows); one that
 * fails stays `baselining` with its run marked failed, and the others go on. A session that handed in no card at all
 * has failed too (`NO_CARDS_ERROR`): an empty dossier is not a baseline.
 *
 * The same job fills in a tracked product's missing dimensions (a dimension added to its track, or one whose card the
 * check rejected); the product stays `tracking` meanwhile, whatever the outcome.
 */
import { localDate } from '../../core/calendar.ts'
import type { Id } from '../../core/types.ts'
import type { ToolSpec } from '../ports.ts'
import { renderPrompt } from '../prompts.ts'
import { researchTools } from '../tools.ts'
import type { JobDeps, JobRunner } from './runner.ts'
import { say } from '../../core/messages.ts'

/** Checks what a product's sessions handed in (Task 9). It must reject when the check could not be done. */
export type VerifyProduct = (productId: Id, scope: 'baseline' | 'daily') => Promise<void>

export interface BaselineDeps extends JobDeps {
  verifyProduct: VerifyProduct
}

/** The error of a baseline run whose session ended without handing in a single card. */
export const NO_CARDS_ERROR = say('noCards')

/**
 * Baselines in flight, per runner (one runner lives as long as Outpost does): a second request for a product whose
 * baseline is still running joins it instead of starting another session (and another check) beside it.
 */
const inFlight = new WeakMap<JobRunner, Map<Id, Promise<void>>>()

/**
 * Whether a baseline of the product is in flight on this runner, its check included (deleting the product waits for it:
 * between the profile session and its check there is no run queued or running).
 */
export function isBaselining(runner: JobRunner, productId: Id): boolean {
  return inFlight.get(runner)?.has(productId) ?? false
}

/**
 * Starts each product's baseline in the background and returns without waiting: a product not tracked yet is marked
 * `baselining` at once; a tracked one keeps its status. A product whose baseline is already running is left to it.
 * Unknown product ids are skipped.
 */
export function startBaseline(deps: BaselineDeps, productIds: Id[]): void {
  void baselineProducts(deps, productIds)
}

/**
 * Like `startBaseline`, but resolves once each product's baseline (its own or the one it joined) is over. It never
 * rejects: how a baseline ended is in its run, and an unexpected failure is logged by the runner.
 */
export function baselineProducts(deps: BaselineDeps, productIds: Id[]): Promise<void> {
  let running = inFlight.get(deps.runner)
  if (!running) inFlight.set(deps.runner, running = new Map())
  const waits: Promise<void>[] = []
  for (const productId of new Set(productIds)) {
    let work = running.get(productId)
    if (!work) {
      const product = deps.repo.getProduct(productId)
      if (!product) continue
      if (product.status !== 'tracking') deps.repo.setProductStatus(productId, 'baselining')
      const map = running
      work = baseline(deps, productId).finally(() => { map.delete(productId) })
      running.set(productId, work)
      deps.runner.track(work, `baseline of product ${productId}`)
    }
    waits.push(work.catch(() => {}))
  }
  return Promise.all(waits).then(() => {})
}

async function baseline(deps: BaselineDeps, productId: Id): Promise<void> {
  const { repo, runner, clock, icons } = deps
  const product = repo.getProduct(productId)
  if (!product) return
  // A card already in the dossier, or handed in by an earlier try and waiting for its check, is not asked for again.
  const covered = new Set([...repo.latestCards(productId), ...repo.pendingCardEdits(productId)].map(c => c.dimension))
  const wanted = repo.dimensionsOfProduct(productId).filter(d => !covered.has(d.key))

  let runId: Id | null = null
  if (wanted.length) {
    const prompt = renderPrompt('baseline', {
      productName: product.name,
      company: product.company,
      form: product.form || '（未知）',
      officialDomains: product.officialDomains.join('、') || '（未知）',
      today: localDate(clock.now()),
      dimensions: wanted.map(d => `- ${d.key}：${d.label}`).join('\n'),
    })
    const total = wanted.length
    const handedIn = new Set<string>()
    const { run, finished } = runner.start('baseline', { productId }, id => ({
      title: `前哨 · ${product.name} 建档`,
      prompt,
      tools: onDone => countCards(researchTools('baseline', { repo, runId: id, trackId: null, productId, now: () => clock.now(), icons, onDone }), dimension => {
        if (!wanted.some(d => d.key === dimension) || handedIn.has(dimension)) return
        handedIn.add(dimension)
        repo.updateRun(id, { progress: { done: handedIn.size, total } })
      }),
    }))
    runId = run.id
    repo.updateRun(run.id, { progress: { done: 0, total } })
    const ended = await finished
    if (ended.status !== 'done') return // stays baselining; the run says why
    if (handedIn.size === 0) {
      repo.updateRun(run.id, { status: 'failed', error: NO_CARDS_ERROR })
      return
    }
  }

  try {
    await deps.verifyProduct(productId, 'baseline')
  } catch (error) {
    if (runId) repo.updateRun(runId, { status: 'failed', error: say('checkNotDone', { reason: error instanceof Error ? error.message : String(error) }) })
    throw error
  }
  repo.setProductStatus(productId, 'tracking')
}

/** `tools` with `outpost_submit_card` reporting the dimension of every card it accepted. */
function countCards(tools: ToolSpec[], accepted: (dimension: string) => void): ToolSpec[] {
  return tools.map(tool => tool.name !== 'outpost_submit_card' ? tool : {
    ...tool,
    async execute(args: unknown) {
      const result = await tool.execute(args)
      const dimension = (args as { dimension?: unknown } | null)?.dimension
      if (result !== null && typeof result === 'object' && 'cardEditId' in result && typeof dimension === 'string') accepted(dimension.trim())
      return result
    },
  })
}
