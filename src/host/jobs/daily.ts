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
import type { JobDeps } from './runner.ts'
import { VerifyNotRun, verifyProduct } from './verify.ts'

/** How far back the prompt looks for the product's last finished run. */
const LOOKBACK_DAYS = 30

/**
 * Runs the daily session for the product, counted toward `date` (`YYYY-MM-DD`: its findings belong to that day's brief,
 * its cost to that day's budget), then the check for the same day. Resolves with the daily run as stored at the end:
 * - `skipped` by the budget: no check either (the budget would refuse it too);
 * - `done`, but the check could not run: the run takes the check's outcome (`skipped` or `failed`) with the error
 *   「核查没有完成：<原因>」, since what it found is still unchecked and shows nowhere yet;
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
  if (run.status === 'skipped') return run

  try {
    await verifyProduct(deps, productId, 'daily', date)
  } catch (error) {
    if (!(error instanceof VerifyNotRun)) throw error
    if (run.status === 'done') repo.updateRun(run.id, { status: error.run.status === 'skipped' ? 'skipped' : 'failed', error: `核查没有完成：${error.message}` })
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
