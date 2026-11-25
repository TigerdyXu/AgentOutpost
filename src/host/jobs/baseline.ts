/**
 * Baseline (design §7.2): each newly tracked product gets one session 「前哨 · <产品> 建档」 that writes a card for every
 * dimension still without one, and the key facts. Its cards then go through the check (`verifyProduct`, Task 9), and
 * only after that does the product count as tracked. Products run side by side (as many as the runner allows); one that
 * fails stays `baselining` with its run marked failed, and the others go on.
 */
import { localDate } from '../../core/calendar.ts'
import type { Id } from '../../core/types.ts'
import type { ToolSpec } from '../ports.ts'
import { renderPrompt } from '../prompts.ts'
import { researchTools } from '../tools.ts'
import type { JobDeps } from './runner.ts'

/** Checks what a product's sessions handed in (Task 9). It must reject when the check could not be done. */
export type VerifyProduct = (productId: Id, scope: 'baseline' | 'daily') => Promise<void>

export interface BaselineDeps extends JobDeps {
  verifyProduct: VerifyProduct
}

/**
 * Marks each product `baselining` at once and starts its baseline in the background; returns without waiting. Unknown
 * product ids are skipped.
 */
export function startBaseline(deps: BaselineDeps, productIds: Id[]): void {
  for (const productId of new Set(productIds)) {
    if (!deps.repo.getProduct(productId)) continue
    deps.repo.setProductStatus(productId, 'baselining')
    deps.runner.track(baseline(deps, productId), `baseline of product ${productId}`)
  }
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
  }

  try {
    await deps.verifyProduct(productId, 'baseline')
  } catch (error) {
    if (runId) repo.updateRun(runId, { status: 'failed', error: `核查没有完成：${error instanceof Error ? error.message : String(error)}` })
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
