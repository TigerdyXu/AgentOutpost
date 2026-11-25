/**
 * The check (design §7.4, §7.5, §8). A `verify` session 「前哨 · <产品> 核查」 opens every source of what waits for a check
 * and reports what it saw (`outpost_report_check`), adding a corroborating source where a finding lacks one. The verdict
 * is then the code's, not the agent's: `judge` decides every pending and unconfirmed finding from those reports, and
 * the card edits are merged by the rules below. Only verified material reaches the dossier, as a new card version.
 */
import { localDate } from '../../core/calendar.ts'
import { applyCardEdit } from '../../core/cards.ts'
import { isValidEvidence, isVoidEvidence, judge, type Evidence } from '../../core/credibility.ts'
import type { CardEdit, Finding, Id, Run, Source, Span } from '../../core/types.ts'
import type { Repo } from '../../store/repo.ts'
import { renderPrompt } from '../prompts.ts'
import { researchTools } from '../tools.ts'
import type { JobDeps } from './runner.ts'

export type VerifyScope = 'baseline' | 'daily'

/** The note of a finding that was 「待确认」 and has now been confirmed (design §7.4: it shows as 「已证实」). */
export const PROMOTED_NOTE = '已证实'

/** The check did not run, so nothing was judged: its run was skipped (budget) or failed (error, time-out, stop). */
export class VerifyNotRun extends Error {
  /** @param run - the `verify` run as it ended; its `error` is the reason. */
  constructor(readonly run: Run) {
    super(run.error ?? (run.status === 'skipped' ? '核查被跳过' : '核查失败'))
    this.name = 'VerifyNotRun'
  }
}

/**
 * Checks what waits for a check on the product, then settles it:
 * - every `pending` and `unconfirmed` finding gets `judge`'s verdict (the 7-day window counts from its `createdAt`;
 *   one that was 「待确认」 and is now verified gets the note 「已证实」);
 * - a daily card edit (one resting on findings) becomes the dimension's next version once all its findings are verified,
 *   is rejected once any of them is withdrawn or unproven, and otherwise waits for the next check;
 * - a baseline card edit (resting on no finding) loses its void sources and their `[n]` (the rest renumbered), and
 *   becomes the dimension's first version if a valid source remains; otherwise it is rejected and the dimension stays
 *   empty (「暂无可核实的信息」);
 * - of several pending edits to one dimension the newest wins; the older ones are rejected, since each is a whole new
 *   text and applying an older one later would undo the newer.
 * Findings past their 7 days are settled before the session starts, so no searching is spent on them; when nothing is
 * left for the agent, no session is started at all.
 *
 * A source the checker never reported on counts as not opened (`openedVia: 'unopened'`): nobody has seen the page, so it
 * neither backs nor voids anything, and a finding resting on it waits as 「待确认」 (「原文打不开」) for the next check.
 *
 * @param date - the day the check counts toward (its brief and budget); default today.
 * @throws VerifyNotRun when the session was skipped or failed; nothing is judged then, all of it waits for the next check.
 * @throws When the product does not exist.
 */
export async function verifyProduct(deps: JobDeps, productId: Id, scope: VerifyScope, date?: string): Promise<void> {
  const { repo, runner, clock, icons } = deps
  const product = repo.getProduct(productId)
  if (!product) throw new Error(`Unknown product ${productId}`)

  settle(repo, productId, clock.now(), false)
  if (!waitsForAgent(repo, productId)) return

  const day = date ?? localDate(clock.now())
  const prompt = renderPrompt('verify', {
    productName: product.name,
    company: product.company,
    officialDomains: product.officialDomains.join('、') || '（未知）',
    today: day,
  })
  const run = await runner.session('verify', { productId, date: day }, runId => ({
    title: scope === 'baseline' ? `前哨 · ${product.name} 建档核查` : `前哨 · ${product.name} 核查 ${day}`,
    prompt,
    tools: onDone => researchTools('verify', { repo, runId, trackId: null, productId, now: () => clock.now(), icons, onDone }),
  }))
  if (run.status !== 'done') throw new VerifyNotRun(run)
  settle(repo, productId, clock.now(), true)
}

/** Whether anything is left that needs the agent: a pending finding or card edit, or an unconfirmed finding still in its window. */
function waitsForAgent(repo: Repo, productId: Id): boolean {
  return repo.openUnconfirmed(productId).length > 0 || repo.pendingCardEdits(productId).length > 0
    || repo.findingsOfProduct(productId).some(f => f.status === 'pending')
}

/**
 * Judges findings and merges card edits as `verifyProduct` describes. Before the check (`checked` false) only what needs
 * no new report is settled: unconfirmed findings whose window has closed, superseded edits, and daily edits whose
 * findings are all decided. After it, everything waiting is.
 */
function settle(repo: Repo, productId: Id, now: Date, checked: boolean): void {
  const open = checked ? repo.findingsOfProduct(productId).filter(f => f.status === 'pending' || f.status === 'unconfirmed') : repo.openUnconfirmed(productId)
  for (const f of open) {
    const verdict = judge({ claimKind: f.claimKind, evidence: repo.getSources(f.sourceIds).map(evidenceOf), firstSeen: new Date(f.createdAt), now })
    if (!checked && verdict.status === 'unconfirmed') continue // still in its window: today's check looks at it again
    const promoted = f.status === 'unconfirmed' && verdict.status === 'verified'
    repo.updateFinding(f.id, { status: verdict.status, statusNote: promoted ? PROMOTED_NOTE : verdict.note, unconfirmedUntil: verdict.unconfirmedUntil })
  }

  const edits = repo.pendingCardEdits(productId) // oldest first
  const newest = new Map(edits.map(e => [e.dimension, e]))
  const findings = new Map(repo.findingsOfProduct(productId).map(f => [f.id, f]))
  for (const edit of edits) {
    if (newest.get(edit.dimension) !== edit) repo.setCardEditStatus(edit.id, 'rejected')
    else if (edit.findingIds.length) mergeDailyEdit(repo, edit, findings, now)
    else if (checked) mergeBaselineEdit(repo, edit, now)
  }
}

function mergeDailyEdit(repo: Repo, edit: CardEdit, findings: Map<Id, Finding>, now: Date): void {
  const statuses = edit.findingIds.map(id => findings.get(id)?.status)
  if (statuses.some(s => s === undefined || s === 'withdrawn' || s === 'unproven')) repo.setCardEditStatus(edit.id, 'rejected')
  else if (statuses.every(s => s === 'verified')) write(repo, edit, sourceCheck(repo, edit).removed, now)
}

function mergeBaselineEdit(repo: Repo, edit: CardEdit, now: Date): void {
  const { removed, valid } = sourceCheck(repo, edit)
  if (valid === 0) repo.setCardEditStatus(edit.id, 'rejected')
  else write(repo, edit, removed, now)
}

/** The edit's sources that the check found void (1-based, as `[n]` counts them), and how many are valid. */
function sourceCheck(repo: Repo, edit: CardEdit): { removed: number[]; valid: number } {
  const byId = new Map(repo.getSources(edit.sourceIds).map(s => [s.id, s]))
  const removed: number[] = []
  let valid = 0
  edit.sourceIds.forEach((id, i) => {
    const source = byId.get(id)
    const evidence = source && evidenceOf(source)
    if (!evidence || isVoidEvidence(evidence)) removed.push(i + 1)
    else if (isValidEvidence(evidence)) valid++
  })
  return { removed, valid }
}

/** Writes the edit, without the `removed` sources, as the dimension's next card version and marks it applied. */
function write(repo: Repo, edit: CardEdit, removed: number[], now: Date): void {
  const previous = repo.latestCards(edit.productId).find(c => c.dimension === edit.dimension) ?? null
  repo.addCardVersion(applyCardEdit(previous, { ...edit, ...withoutSources(edit, removed) }, now))
  repo.setCardEditStatus(edit.id, 'applied')
}

/** A source as `judge` sees it; one nobody reported on counts as not opened (see `verifyProduct`). */
function evidenceOf(s: Source): Evidence {
  const seen = s.openedVia === null
    ? { openedVia: 'unopened' as const, quoteFound: null, supportsClaim: null }
    : { openedVia: s.openedVia, quoteFound: s.quoteFound, supportsClaim: s.supportsClaim }
  return { url: s.url, isOfficial: s.isOfficial, syndicationGroup: s.syndicationGroup, ...seen }
}

// ---- citations ----

/** A citation in a card body: `[n]`, n counting the card's sources from 1 (the tools allow no other bracketed number). */
const CITATION = /\[(\d+)\]/g

interface Replacement { from: number; to: number; text: string }

/** Every citation of `body` with what it becomes once the sources numbered `removed` are gone. */
function citationEdits(body: string, removed: readonly number[]): Replacement[] {
  const gone = [...new Set(removed)]
  return [...body.matchAll(CITATION)].map(m => {
    const n = Number(m[1])
    const from = m.index
    return { from, to: from + m[0].length, text: gone.includes(n) ? '' : `[${n - gone.filter(r => r < n).length}]` }
  })
}

/**
 * Where a position of the old body lies in the new one. A position inside a citation moves to the start of what replaced
 * it (`side` start) or to its end (`side` end), so a span never ends up holding part of a marker.
 */
function moveOffset(edits: Replacement[], pos: number, side: 'start' | 'end'): number {
  let shift = 0
  for (const e of edits) {
    if (pos <= e.from) break
    if (pos >= e.to) { shift += e.text.length - (e.to - e.from); continue }
    return e.from + shift + (side === 'start' ? 0 : e.text.length)
  }
  return pos + shift
}

/**
 * `body` without the citations of the sources numbered `removed`, the rest renumbered to close the gaps:
 * `renumberCitations('甲[1]乙[2]丙[3]', [2])` is `'甲[1]乙丙[2]'`.
 */
export function renumberCitations(body: string, removed: number[]): string {
  let out = ''
  let last = 0
  for (const e of citationEdits(body, removed)) {
    out += body.slice(last, e.from) + e.text
    last = e.to
  }
  return out + body.slice(last)
}

/**
 * A card without the sources numbered `removed` (1-based): those leave `sourceIds`, their `[n]` leave the body, the
 * other citations are renumbered, and the 推论 marks (`inferenceSpans`, UTF-16 offsets into the body) move with the text
 * they cover. A mark left covering nothing is dropped.
 */
export function withoutSources(card: Pick<CardEdit, 'body' | 'sourceIds' | 'inferenceSpans'>, removed: number[]): Pick<CardEdit, 'body' | 'sourceIds' | 'inferenceSpans'> {
  const edits = citationEdits(card.body, removed)
  const inferenceSpans: Span[] = card.inferenceSpans
    .map(s => ({ start: moveOffset(edits, s.start, 'start'), end: moveOffset(edits, s.end, 'end') }))
    .filter(s => s.end > s.start)
  return {
    body: renumberCitations(card.body, removed),
    sourceIds: card.sourceIds.filter((_, i) => !removed.includes(i + 1)),
    inferenceSpans,
  }
}
