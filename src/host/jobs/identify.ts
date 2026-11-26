/**
 * 确认产品 (M1.2 按名字加): a product the user names by hand, not found among the products Outpost follows, gets one small
 * session 「前哨 · 确认产品 <name>」. The agent checks that it exists, is still running and belongs to the track, and hands
 * it in as a single candidate, with its company, region, form, official site and icon. A passed one (`strong` or
 * `consider`) joins the track as a product picked under 候选推荐 does (`joinTrack`: baselined, or for a product followed
 * elsewhere only topped up); an `excluded` one, or none, joins nothing and the run says why. Its candidate is no batch of
 * recommendations (`Repo.latestBatchId`), so the batch the user is picking from stays.
 */
import { localDate } from '../../core/calendar.ts'
import type { Id, Run } from '../../core/types.ts'
import { joinTrack, type JoinDeps } from '../join.ts'
import { renderPrompt } from '../prompts.ts'
import { researchTools } from '../tools.ts'
import type { JobDeps } from './runner.ts'

export interface IdentifyDeps extends JobDeps {
  /** What baselines or tops up the product once it joins (`Scheduler`). */
  scheduler: JoinDeps['scheduler']
}

/** The `error` of a confirmation that ended without a candidate. */
export const NOT_FOUND = '没有找到这个产品'

/**
 * Starts confirming the product named `ask.name` (with the official site the user gave, if any) for the track, and
 * answers with the run's id at once; the session runs in the background and needs none of the `maxParallel` places.
 * The run keeps the name as typed (`subject`) and, once a passed product joined, that product (`productId`). A run that
 * ended without one keeps why in `error`: the agent's reason for turning the product down, 「没有找到这个产品」 when it
 * handed in nothing, or why the run itself was skipped or failed.
 * @throws When the track does not exist (nothing is started then).
 */
export async function startIdentify(deps: IdentifyDeps, trackId: Id, ask: { name: string; officialUrl: string | null }): Promise<Id> {
  const { repo, runner, clock, icons } = deps
  const track = repo.listTracks().find(t => t.id === trackId)
  if (!track) throw new Error(`Unknown track ${trackId}`)
  const name = ask.name.trim()
  const prompt = renderPrompt('identify', {
    trackName: track.name,
    trackBrief: track.brief || '（没有写）',
    today: localDate(clock.now()),
    name,
    officialUrl: ask.officialUrl?.trim() || '（没有给）',
  })

  const { run, finished } = runner.start('identify', { trackId, subject: name }, runId => ({
    title: `前哨 · 确认产品 ${name}`,
    prompt,
    tools: onDone => researchTools('identify', { repo, runId, trackId, productId: null, now: () => clock.now(), icons, onDone }),
    settle: ended => { settle(deps, ended) },
  }))
  runner.track(finished, `confirmation of 「${name}」 for track ${trackId}`)
  return run.id
}

/**
 * What a confirmation that is over comes to, in the step that stores it as over: its product joins the track, or the run
 * says why not. (A run the budget skipped never had a session, nor this.)
 */
function settle(deps: IdentifyDeps, run: Run): void {
  const { repo, runner } = deps
  const trackId = run.trackId!
  // The one candidate the agent may hand in (`outpost_submit_candidate` refuses a second).
  const [candidate] = repo.listCandidates(trackId, run.id)
  if (candidate && candidate.tier !== 'excluded') {
    // It passed: whatever happened after it was handed in (no outpost_done, say), the agent's check stands.
    const join: JoinDeps = { repo, scheduler: deps.scheduler, background: (work, label) => { runner.track(work, label) } }
    const [joined] = joinTrack(join, trackId, [candidate.productId])
    if (joined) repo.updateRun(run.id, { productId: joined.productId })
    return
  }
  if (candidate) repo.updateRun(run.id, { error: candidate.reason })
  else if (run.status === 'done') repo.updateRun(run.id, { error: NOT_FOUND })
}
