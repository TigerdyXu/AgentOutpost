/**
 * The daily update of one product (design §7.3): a session 「前哨 · <产品> 日更 <日期>」 reads what Outpost already knows
 * (`outpost_read`) and hands in only what is new since the last run, one finding per event, with card edits resting on
 * them. Everything it hands in then goes through the check (`verifyProduct`), which also tries the product's 「待确认」
 * findings again.
 */
import { localDate } from '../../core/calendar.ts'
import type { Id, Run } from '../../core/types.ts'
import type { Repo } from '../../store/repo.ts'
import { renderPrompt } from '../prompts.ts'
import { researchTools } from '../tools.ts'
import { STOPPED_ERROR, type JobDeps } from './runner.ts'
import { VerifyNotRun, verifyProduct } from './verify.ts'

/** How far back the prompt looks for the product's last finished run. */
const LOOKBACK_DAYS = 30

/** The note on a daily run that did its work but whose check the budget did not allow: its findings wait, unshown, for the next check. */
export const VERIFY_BUDGET_NOTE = '核查因预算未完成'

/**
 * Runs the daily session for the product, counted toward `date` (`YYYY-MM-DD`: its findings belong to that day's brief,
 * its cost to that day's budget), then the check for the same day. Resolves with the daily run as stored at the end:
 * - `skipped` by the budget: no check either (the budget would refuse it too);
 * - `failed` because Outpost was stopping (`STOPPED_ERROR`): no check; the product runs again on the next start;
 * - `done`, but the budget did not allow the check: still `done` (the day's work for it is over), with the note
 *   `VERIFY_BUDGET_NOTE`; its findings stay pending, unshown, and the next check takes them;
 * - `done`, but the check was cut short by a stop: `failed` with `STOPPED_ERROR`, so that it counts as interrupted;
 * - `done`, but the check failed: `failed` with the error 「核查没有完成：<原因>」, since what it found is still
 *   unchecked and shows nowhere yet;
 * - `failed`: what it handed in before failing is checked all the same, and the run keeps its own error.
 * @throws When the product does not exist (nothing is started), or the store fails.
 */
export async function runDailyProduct(deps: JobDeps, productId: Id, date: string): Promise<Run> {
  const { repo, runner, clock, icons } = deps
  const product = repo.getProduct(productId)
  if (!product) throw new Error(`Unknown product ${productId}`)

  const last = lastRunDate(repo, productId, date)
  const prompt = renderPrompt('daily', {
    productName: product.name,
    company: product.company,
    form: product.form || '（未知）',
    officialDomains: product.officialDomains.join('、') || '（未知）',
    today: date,
    lastRun: last ?? '（没有记录，查近 14 天的）',
  })
  const run = await runner.session('daily', { productId, date }, runId => ({
    title: `前哨 · ${product.name} 日更 ${date}`,
    prompt,
    tools: onDone => researchTools('daily', { repo, runId, trackId: null, productId, now: () => clock.now(), icons, onDone }),
  }))
  if (run.status === 'skipped' || (run.status === 'failed' && run.error === STOPPED_ERROR)) return run

  try {
    await verifyProduct(deps, productId, 'daily', date)
  } catch (error) {
    if (!(error instanceof VerifyNotRun)) throw error
    if (run.status !== 'done') return repo.getRun(run.id)! // its own failure stands
    const check = error.run
    if (check.status === 'skipped') repo.updateRun(run.id, { error: VERIFY_BUDGET_NOTE })
    else if (check.error === STOPPED_ERROR) repo.updateRun(run.id, { status: 'failed', error: STOPPED_ERROR })
    else repo.updateRun(run.id, { status: 'failed', error: `核查没有完成：${error.message}` })
  }
  return repo.getRun(run.id)!
}

/** The day of the product's last daily or baseline run that finished before `date` (looking back 30 days), or null. */
function lastRunDate(repo: Repo, productId: Id, date: string): string | null {
  const [y, m, d] = date.split('-').map(Number)
  const dates = repo.listRuns(localDate(new Date(y!, m! - 1, d! - LOOKBACK_DAYS)))
    .filter(r => r.productId === productId && (r.kind === 'daily' || r.kind === 'baseline') && r.status === 'done' && r.date < date)
    .map(r => r.date)
  return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null
}
