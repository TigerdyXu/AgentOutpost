/**
 * Recommendation (design §7.1): one session 「前哨 · 推荐 <赛道>」 searches the track's products and hands them in one by
 * one with `outpost_submit_candidate`, so the picking page fills up while it runs. Every recommendation, refinement or
 * weekly refresh is a new batch, and the batch id is the id of its run.
 */
import { localDate } from '../../core/calendar.ts'
import { FOLLOWED } from '../../core/identity.ts'
import type { CandidateTier, Id } from '../../core/types.ts'
import { renderPrompt } from '../prompts.ts'
import { researchTools } from '../tools.ts'
import type { JobDeps } from './runner.ts'

const TIER_LABEL: Record<CandidateTier, string> = { strong: '强烈推荐', consider: '可以考虑', excluded: '没推荐' }

/**
 * Starts a recommendation for the track and answers with the new batch id at once; the session runs in the background
 * and its candidates appear in the batch as the agent submits them. The prompt carries the track, the user's request
 * `refine` (if any), the previous batch with each candidate's tier and reason, and the products other tracks follow,
 * named as they are kept.
 * @throws When the track does not exist (nothing is started then).
 */
export async function startRecommendation(deps: JobDeps, trackId: Id, refine?: string): Promise<Id> {
  const { repo, runner, clock, icons } = deps
  const track = repo.listTracks().find(t => t.id === trackId)
  if (!track) throw new Error(`Unknown track ${trackId}`)

  const previousBatch = repo.latestBatchId(trackId)
  const previous = previousBatch === null ? [] : repo.listCandidates(trackId, previousBatch).flatMap(c => {
    const product = repo.getProduct(c.productId)
    return product ? [`- ${product.name}（${product.company}）：${TIER_LABEL[c.tier]}。${c.reason}`] : []
  })
  const here = repo.productsOfTrack(trackId)
  const tracked = here.filter(p => p.status !== 'candidate' && p.status !== 'archived').map(p => p.name)
  // What other tracks follow, spelled as it is kept: the agent is asked to copy that spelling, so that a recommendation
  // lands on the product already tracked instead of a second row for it.
  const inThisTrack = new Set(here.map(p => p.id))
  const elsewhere = new Map(repo.listTracks().filter(t => t.id !== trackId).flatMap(t => repo.productsOfTrack(t.id))
    .filter(p => FOLLOWED.includes(p.status) && !inThisTrack.has(p.id)).map(p => [p.id, `${p.name}（${p.company}）`]))
  const request = refine?.trim()
  const prompt = renderPrompt('recommend', {
    trackName: track.name,
    trackBrief: track.brief || '（没有写）',
    dimensions: track.dimensions.map(d => d.label).join('、'),
    today: localDate(clock.now()),
    tracked: tracked.length ? tracked.join('、') : '（还没有）',
    elsewhere: elsewhere.size ? [...elsewhere.values()].join('、') : '（没有）',
    previous: previous.length ? previous.join('\n') : '（没有，这是第一次推荐）',
    refine: request || '（没有）',
  })

  const { run, finished } = runner.start('recommend', { trackId }, runId => ({
    title: `前哨 · 推荐 ${track.name}`,
    prompt,
    tools: onDone => researchTools('recommend', { repo, runId, trackId, productId: null, now: () => clock.now(), icons, onDone }),
  }))
  runner.track(finished, `recommendation for track ${trackId}`)
  return run.id
}
