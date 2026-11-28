/**
 * The day's brief (design §5.2, §7.5): the findings it shows and in what order, the one-sentence gist on top, the
 * products with nothing new (「今天没动静」), and those not updated that day (budget, failure).
 *
 * Which findings: those handed in by the day's own runs (`findingsOfDate`) and those verified that day
 * (`findingsVerifiedOn`), once each. The second set is how a 「待确认」 finding confirmed days later reaches the brief of
 * the day it was confirmed (design §7.4: 「作为『已证实』出现在当天哨报里」); it stays in its own day's brief as well.
 *
 * How the panel tells such a promotion apart, in the brief of `date`: `finding.verifiedOn === date` and
 * `finding.statusNote === PROMOTED_NOTE` (「已证实」; the check sets that note only when a 「待确认」 finding becomes
 * verified). It is labelled 「已证实」 there. Comparing `localDate(finding.createdAt)` with `date` instead would misfire:
 * a catch-up run after midnight hands in findings of the day before, created on the next calendar day.
 *
 * Which products: those with a daily run that day. One with a `done` run is looked at (quiet if it has nothing in the
 * brief); one whose last run was skipped by the budget, or whose check the budget did not allow, is named in `skipped`
 * with the reason; one whose last run failed is named with `failed: true` (「未能更新」, design §7.9); one still running,
 * or interrupted by a stop, is neither, until a later recomposition (`appendLate`) finds it finished.
 */
import { composeBrief, NO_NEWS_GIST } from '../../core/brief.ts'
import { costOf } from '../../core/cost.ts'
import { modelFor, type ModelSettings } from '../../core/models.ts'
import type { Brief, Finding, Id, Run } from '../../core/types.ts'
import type { Repo } from '../../store/repo.ts'
import type { Clock, ModelClient } from '../ports.ts'
import { renderPrompt } from '../prompts.ts'
import { VERIFY_BUDGET_NOTE } from './daily.ts'
import { budgetRefusal, STOPPED_ERROR, type RuntimeSettings } from './runner.ts'
import { PROMOTED_NOTE } from './verify.ts'
import { say } from '../../core/messages.ts'

export interface BriefDeps {
  repo: Repo
  /** Writes with the brief's model (`modelFor('brief')`, as the runtime builds it). */
  model: ModelClient
  clock: Clock
  /**
   * Read on each use: the day's budget (the gist is not written once it is spent, unless the brief's model costs nothing),
   * and the models, how they are paid and their prices: the gist's tokens are priced by the brief's model.
   */
  settings: () => Pick<RuntimeSettings, 'dailyBudgetYuan' | 'billingFor' | 'pricesOf'> & ModelSettings
  /** Aborts when Outpost stops (`JobRunner.lifetime`): a gist being written is given up at once, not after its 2 minutes. */
  stop?: AbortSignal
}

/** The gist is at most this many characters (code points), punctuation included. */
export const GIST_MAX_CHARS = 60
const GIST_TIMEOUT_MS = 2 * 60_000
/** The note on a synthesize run whose answer could not be used. */
const UNUSABLE_GIST = say('unusableGist', { max: GIST_MAX_CHARS })
const IMPORTANCE = { major: '重要', notable: '值得留意', minor: '小更新' } as const

/**
 * Writes the brief of `date` from what is known now and stores it, replacing an earlier one of that day (whose
 * creation time it keeps). When nothing `major` or `notable` is shown the gist is `NO_NEWS_GIST` and the model is not
 * called; otherwise the model writes it (`prompts/synthesize.md`) in a `synthesize` run dated `date`, which carries its
 * cost. When the answer cannot be used (empty, over 60 字, the call failed or was cut short by a stop, or the day's budget
 * is spent) the gist is a plain sentence made from the top finding.
 */
export async function synthesizeBrief(deps: BriefDeps, date: string): Promise<Brief> {
  return compose(deps, date, null)
}

/**
 * Adds a product that finished after the brief was written (after the cutoff) to the brief of `date`: its findings of
 * that day not in the brief yet are marked `late` (「迟到」), and the brief is composed again. The gist stays, unless it
 * was `NO_NEWS_GIST` and there is now something to sum up; then it is written as `synthesizeBrief` would. When the day
 * has no brief yet, this is `synthesizeBrief` (nothing came before, so nothing is late).
 */
export async function appendLate(deps: BriefDeps, date: string, productId: Id): Promise<Brief> {
  const previous = deps.repo.getBrief(date)
  if (!previous) return synthesizeBrief(deps, date)
  const listed = new Set([...previous.findingIds, ...previous.minorIds])
  for (const f of deps.repo.findingsOfDate(date))
    if (f.productId === productId && !f.late && !listed.has(f.id)) deps.repo.updateFinding(f.id, { late: true })
  return compose(deps, date, previous.gist)
}

/**
 * The model's answer as a gist: surrounding quotes and a leading 「总结：」 removed, line breaks folded into a space.
 * Null when nothing is left or it is longer than `GIST_MAX_CHARS`.
 */
export function cleanGist(text: string): string | null {
  const edges = /^[\s"'`“”‘’「」『』《》]+|[\s"'`“”‘’「」『』《》]+$/gu
  const gist = text.replace(edges, '').replace(/^(?:今日|今天的?)?(?:一句话)?总结[:：]\s*/u, '').replace(edges, '').replace(/\s*[\r\n]+\s*/g, ' ').trim()
  return gist && chars(gist) <= GIST_MAX_CHARS ? gist : null
}

// ---- composing ----

/**
 * Composes and stores the brief of `date`; `kept` is the gist to keep (null: write one). What the brief lists is read
 * again after the model call: another product may have finished, or another write of this brief gone through, while
 * the model was writing, and storing the earlier reading would silently drop that.
 */
async function compose(deps: BriefDeps, date: string, kept: string | null): Promise<Brief> {
  const { repo, clock } = deps
  const read = () => {
    const findings = dayFindings(repo, date)
    const { tracked, skipped } = dayProducts(repo, date)
    const make = (gist: string) => composeBrief({
      date, findings, trackedProductIds: tracked, skipped, gist, costYuan: repo.spentOn(date), now: clock.now(), previous: repo.getBrief(date),
    })
    const byId = new Map(findings.map(f => [f.id, f]))
    return { make, main: make(NO_NEWS_GIST).findingIds.map(id => byId.get(id)!) } // main: in reading order
  }

  let state = read()
  let gist = NO_NEWS_GIST
  if (state.main.length) {
    if (kept !== null && kept !== NO_NEWS_GIST) gist = kept
    else {
      gist = await writeGist(deps, date, state.main)
      state = read()
    }
  }
  const brief = state.make(state.main.length ? gist : NO_NEWS_GIST) // after the gist, so that its cost is in the day's total
  repo.putBrief(brief)
  return brief
}

/** The findings of `date`'s brief: the day's own, and those verified that day (promotions), once each. */
function dayFindings(repo: Repo, date: string): Finding[] {
  const byId = new Map<Id, Finding>()
  for (const f of [...repo.findingsOfDate(date), ...repo.findingsVerifiedOn(date)]) if (!byId.has(f.id)) byId.set(f.id, f)
  return [...byId.values()]
}

/** The products looked at on `date` (in tracking order) and those named as not updated, from the day's daily runs. */
function dayProducts(repo: Repo, date: string): { tracked: Id[]; skipped: Brief['skipped'] } {
  const runs = new Map<Id, Run[]>()
  for (const run of repo.runsOfDate(date, 'daily')) if (run.productId) runs.set(run.productId, [...runs.get(run.productId) ?? [], run])
  const order = new Set([...repo.listTracks().flatMap(t => repo.productsOfTrack(t.id).map(p => p.id)), ...runs.keys()])
  const tracked: Id[] = []
  const skipped: Brief['skipped'] = []
  for (const productId of order) {
    const ofProduct = runs.get(productId)
    if (!ofProduct) continue
    if (ofProduct.some(r => r.status === 'done' && r.error !== VERIFY_BUDGET_NOTE)) { tracked.push(productId); continue }
    if (ofProduct.some(r => r.status === 'done')) { skipped.push({ productId, reason: VERIFY_BUDGET_NOTE }); continue }
    const last = ofProduct.at(-1)!
    if (last.status === 'skipped') skipped.push({ productId, reason: last.error ?? say('budgetToday') })
    else if (last.status === 'failed' && last.error !== STOPPED_ERROR) skipped.push({ productId, reason: last.error ?? say('runFailed'), failed: true })
    // queued, running, or interrupted by a stop: not finished yet
  }
  return { tracked, skipped }
}

// ---- the gist ----

/** Asks the model for the gist of `main` (the shown major and notable findings, in reading order), in a `synthesize` run. */
async function writeGist(deps: BriefDeps, date: string, main: Finding[]): Promise<string> {
  const { repo, model, clock, settings } = deps
  const name = (productId: Id) => repo.getProduct(productId)?.name ?? '某产品'
  const fallback = fallbackGist(main[0]!, name(main[0]!.productId), main.length - 1)
  const run = repo.createRun({ kind: 'synthesize', date, trackId: null, productId: null })
  const end = (patch: Partial<Run>) => repo.updateRun(run.id, { endedAt: clock.now().toISOString(), ...patch })

  const writer = modelFor('brief', settings()) // the model the client writes with: the brief's, as configured now
  const refused = budgetRefusal(repo, settings(), writer, date, null) // none on a local or subscription model
  if (refused) {
    end({ status: 'skipped', error: refused })
    return fallback
  }
  repo.updateRun(run.id, { status: 'running', startedAt: clock.now().toISOString() })
  try {
    const user = [`日期：${date}`, '今天值得看的发现（按重要程度排）：', ...main.map((f, i) => describe(f, i + 1, name(f.productId), date))].join('\n')
    const timeout = AbortSignal.timeout(GIST_TIMEOUT_MS)
    const { text, usage } = await model.complete({ system: renderPrompt('synthesize', {}), user }, deps.stop ? AbortSignal.any([timeout, deps.stop]) : timeout)
    const gist = cleanGist(text)
    end({ status: 'done', usage, costYuan: costOf(usage, settings().pricesOf(writer, clock.now())), error: gist === null ? UNUSABLE_GIST : null })
    return gist ?? fallback
  } catch (error) {
    // Cut short by a stop: interrupted, not broken (the brief is written again on the next start).
    end({ status: 'failed', error: deps.stop?.aborted ? STOPPED_ERROR : error instanceof Error ? error.message : String(error) })
    return fallback
  }
}

/** One finding as the model reads it. */
function describe(f: Finding, n: number, productName: string, date: string): string {
  const marks = [productName, IMPORTANCE[f.importance]]
  if (f.status === 'unconfirmed') marks.push('待确认')
  if (f.verifiedOn === date && f.statusNote === PROMOTED_NOTE) marks.push('之前待确认，今天已证实')
  return `${n}. ${marks.join('｜')}｜${f.headline}\n   为什么值得注意：${f.why}`
}

/**
 * The gist when the model's cannot be used: 「<产品>：<标题>」 (just the headline when it names the product), 「（待确认）」
 * when it is unconfirmed, then 「；另有 n 条值得看」 when it fits in 60 字. The headline alone when nothing longer fits.
 */
function fallbackGist(top: Finding, productName: string, more: number): string {
  const subject = (top.headline.includes(productName) ? top.headline : `${productName}：${top.headline}`) + (top.status === 'unconfirmed' ? '（待确认）' : '')
  const full = more > 0 ? `${subject}；另有 ${more} 条值得看` : subject
  if (chars(full) <= GIST_MAX_CHARS) return full
  if (chars(subject) <= GIST_MAX_CHARS) return subject
  return [...top.headline].slice(0, GIST_MAX_CHARS).join('')
}

const chars = (text: string) => [...text].length
