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

/** Why a check whose session ended without `outpost_done` (out of room, or it just stopped) decides nothing. */
export const STOPPED_EARLY = '会话没有调用 outpost_done 就停了，这次不下结论'

/**
 * The check did not run to its end, so nothing was judged: its run was skipped (budget), failed (error, time-out, stop),
 * or ended without `outpost_done` (then it is recorded as failed).
 */
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
 *   one that was 「待确认」 and is now verified gets the note 「已证实」). A finding found verified gets `verifiedOn` =
 *   the day being processed (`date`), unless it already has one, so a promotion shows in that day's brief;
 * - a card edit is written only without what its void sources said (`withoutVoidClaims`: each sentence resting on one
 *   goes, with any bullet that repeats it), and only if a valid source remains and so do its summary and a bullet;
 *   otherwise it is rejected (the dimension keeps its card, or shows 「暂无可核实的信息」 without one);
 * - a daily card edit (one resting on findings) is written that way once all its findings are verified, is rejected
 *   once any of them is withdrawn or unproven, and otherwise waits for the next check;
 * - a baseline card edit (resting on no finding) is written that way, normally as version 1;
 * - of several pending edits to one dimension the newest wins; the older ones are rejected, since each is a whole new
 *   text and applying an older one later would undo the newer.
 * Findings past their 7 days are settled before the session starts, so no searching is spent on them; when nothing is
 * left for the agent, no session is started at all.
 *
 * A source the checker never reported on counts as not opened (`openedVia: 'unopened'`): nobody has seen the page, so it
 * neither backs nor voids anything, and a finding resting on it waits as 「待确认」 (「原文打不开」) for the next check.
 *
 * @param date - the day the check counts toward (its brief, its budget, and `verifiedOn`); default today.
 * @throws VerifyNotRun when the session was skipped, failed, or ended without `outpost_done`: a partial report would
 *   make every source not reached count as unopened, so nothing is judged then. All of it waits for the next check,
 *   and what the checker did report stays on the sources, so that check does not open them again.
 * @throws When the product does not exist.
 */
export async function verifyProduct(deps: JobDeps, productId: Id, scope: VerifyScope, date?: string): Promise<void> {
  const { repo, runner, clock, icons } = deps
  const product = repo.getProduct(productId)
  if (!product) throw new Error(`Unknown product ${productId}`)

  const day = date ?? localDate(clock.now())
  settle(repo, productId, day, clock.now(), false)
  if (!waitsForAgent(repo, productId)) return

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
  if (run.error !== null) { // done, but without outpost_done: the runner's note that it stopped early
    repo.updateRun(run.id, { status: 'failed', error: STOPPED_EARLY })
    throw new VerifyNotRun(repo.getRun(run.id)!)
  }
  settle(repo, productId, day, clock.now(), true)
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
function settle(repo: Repo, productId: Id, day: string, now: Date, checked: boolean): void {
  const open = checked ? repo.findingsOfProduct(productId).filter(f => f.status === 'pending' || f.status === 'unconfirmed') : repo.openUnconfirmed(productId)
  for (const f of open) {
    const verdict = judge({ claimKind: f.claimKind, evidence: repo.getSources(f.sourceIds).map(evidenceOf), firstSeen: new Date(f.createdAt), now })
    if (!checked && verdict.status === 'unconfirmed') continue // still in its window: today's check looks at it again
    const promoted = f.status === 'unconfirmed' && verdict.status === 'verified'
    repo.updateFinding(f.id, {
      status: verdict.status, statusNote: promoted ? PROMOTED_NOTE : verdict.note, unconfirmedUntil: verdict.unconfirmedUntil,
      verifiedOn: verdict.status === 'verified' ? f.verifiedOn ?? day : undefined, // the first verified day stands
    })
  }

  const edits = repo.pendingCardEdits(productId) // oldest first
  const newest = new Map(edits.map(e => [e.dimension, e]))
  const findings = new Map(repo.findingsOfProduct(productId).map(f => [f.id, f]))
  for (const edit of edits) {
    if (newest.get(edit.dimension) !== edit) repo.setCardEditStatus(edit.id, 'rejected')
    else if (edit.findingIds.length) mergeDailyEdit(repo, edit, findings, now)
    else if (checked) writeIfBacked(repo, edit, now)
  }
}

function mergeDailyEdit(repo: Repo, edit: CardEdit, findings: Map<Id, Finding>, now: Date): void {
  const statuses = edit.findingIds.map(id => findings.get(id)?.status)
  if (statuses.some(s => s === undefined || s === 'withdrawn' || s === 'unproven')) repo.setCardEditStatus(edit.id, 'rejected')
  else if (statuses.every(s => s === 'verified')) writeIfBacked(repo, edit, now)
}

/** Writes the edit without what its void sources said if a valid source and enough of it remain; rejects it otherwise. */
function writeIfBacked(repo: Repo, edit: CardEdit, now: Date): void {
  const { removed, valid } = sourceCheck(repo, edit)
  const kept = valid.length ? withoutVoidClaims(edit, removed, valid) : null
  if (!kept) repo.setCardEditStatus(edit.id, 'rejected')
  else write(repo, edit, kept, now)
}

/** The edit's sources that the check found void, and those it found valid (1-based, as `[n]` counts them). */
function sourceCheck(repo: Repo, edit: CardEdit): { removed: number[]; valid: number[] } {
  const byId = new Map(repo.getSources(edit.sourceIds).map(s => [s.id, s]))
  const removed: number[] = []
  const valid: number[] = []
  edit.sourceIds.forEach((id, i) => {
    const source = byId.get(id)
    const evidence = source && evidenceOf(source)
    if (!evidence || isVoidEvidence(evidence)) removed.push(i + 1)
    else if (isValidEvidence(evidence)) valid.push(i + 1)
  })
  return { removed, valid }
}

/** Writes the edit, as `kept` left it, as the dimension's next card version and marks it applied. */
function write(repo: Repo, edit: CardEdit, kept: CardText, now: Date): void {
  const previous = repo.latestCards(edit.productId).find(c => c.dimension === edit.dimension) ?? null
  repo.addCardVersion(applyCardEdit(previous, { ...edit, ...kept }, now))
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

/**
 * Where a sentence of a card body ends: after 。！？ or ；, with any citations written right after the mark, or after a
 * line break (a line without a full stop, such as a list item).
 */
const SENTENCE_END = /[。！？；](?:\[\d+\])*|\n/g

/** How many characters in a row a bullet or the summary must share with a dropped sentence to count as repeating it. */
export const ECHO_CHARS = 8

/** The text of a card edit that the check may cut. */
export type CardText = Pick<CardEdit, 'summary' | 'bullets' | 'body' | 'sourceIds' | 'inferenceSpans'>

interface Replacement { from: number; to: number; text: string }
interface Range { from: number; to: number }

const within = (inner: Range, outer: Range) => inner.from >= outer.from && inner.to <= outer.to

/** Every citation of `body` with what it becomes once the sources numbered `removed` are gone. */
function citationEdits(body: string, removed: readonly number[]): (Replacement & { n: number })[] {
  const gone = [...new Set(removed)]
  return [...body.matchAll(CITATION)].map(m => {
    const n = Number(m[1])
    const from = m.index
    return { from, to: from + m[0].length, n, text: gone.includes(n) ? '' : `[${n - gone.filter(r => r < n).length}]` }
  })
}

/** The sentences of `body`, in order and covering all of it (see `SENTENCE_END`). */
function sentences(body: string): Range[] {
  const out: Range[] = []
  let from = 0
  for (const m of body.matchAll(SENTENCE_END)) {
    out.push({ from, to: m.index + m[0].length })
    from = m.index + m[0].length
  }
  if (from < body.length) out.push({ from, to: body.length })
  return out
}

/**
 * Where a position of the old body lies in the new one. A position inside a replaced stretch (a citation, a dropped
 * sentence) moves to the start of what replaced it (`side` start) or to its end (`side` end), so a span never ends up
 * holding part of a marker.
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

/** `body` with the `edits` (in order, not overlapping) made. */
function applyEdits(body: string, edits: Replacement[]): string {
  let out = ''
  let last = 0
  for (const e of edits) {
    out += body.slice(last, e.from) + e.text
    last = e.to
  }
  return out + body.slice(last)
}

/**
 * `body` without the citations of the sources numbered `removed`, the rest renumbered to close the gaps:
 * `renumberCitations('甲[1]乙[2]丙[3]', [2])` is `'甲[1]乙丙[2]'`.
 */
export function renumberCitations(body: string, removed: number[]): string {
  return applyEdits(body, citationEdits(body, removed))
}

/** A text as the echo test compares it: full-width forms folded, citations, whitespace and punctuation gone, as characters. */
const echoText = (text: string) => [...text.replace(CITATION, '').normalize('NFKC').replace(/[\s\p{P}]/gu, '')]

/** Whether `line` shares `ECHO_CHARS` or more characters in a row with `sentence` (both compared as `echoText`). */
function echoes(line: string, sentence: string): boolean {
  const said = echoText(sentence).join('')
  const chars = echoText(line)
  for (let i = 0; i + ECHO_CHARS <= chars.length; i++) if (said.includes(chars.slice(i, i + ECHO_CHARS).join(''))) return true
  return false
}

/**
 * A card without what its void sources said (design §2, §8.1: nothing goes into the dossier without a source that backs
 * it). `removed` are the void sources, `valid` the valid ones (1-based); any other source was not seen either way.
 * - Each sentence (split after 。！？； or a line break, see `SENTENCE_END`) citing a void source goes, unless it also cites
 *   a valid one; there only the void citation goes.
 * - The void sources leave `sourceIds`, and so does any source whose every citation went with a dropped sentence; the
 *   remaining citations are renumbered to close the gaps. The 推论 marks (`inferenceSpans`, UTF-16 offsets into the
 *   body) move with the text they cover; one left covering nothing is dropped.
 * - A bullet sharing `ECHO_CHARS` or more characters in a row with a dropped sentence (compared without width, spaces,
 *   punctuation and citations) goes too.
 * Null, so that the edit is rejected, when the summary repeats a dropped sentence that way, or no bullet or no text is left.
 */
export function withoutVoidClaims(card: CardText, removed: number[], valid: number[]): CardText | null {
  const citations = citationEdits(card.body, [])
  const isVoid = (n: number) => removed.includes(n)
  const backs = (n: number) => valid.includes(n) && !isVoid(n)
  const cut = sentences(card.body).filter(s => {
    const cited = citations.filter(c => within(c, s)).map(c => c.n)
    return cited.some(isVoid) && !cited.some(backs)
  })
  const kept = citations.filter(c => !cut.some(s => within(c, s)))
  const uncited = [...new Set(citations.map(c => c.n))].filter(n => !kept.some(c => c.n === n))
  const drop = [...new Set([...removed, ...uncited])]
  const edits: Replacement[] = [
    ...cut.map(s => ({ ...s, text: '' })),
    ...citationEdits(card.body, drop).filter(c => !cut.some(s => within(c, s))),
  ].sort((a, b) => a.from - b.from)

  const spaced = applyEdits(card.body, edits)
  const lead = spaced.length - spaced.trimStart().length
  const body = spaced.trim()
  const inferenceSpans: Span[] = card.inferenceSpans
    .map(s => ({ start: moveOffset(edits, s.start, 'start') - lead, end: moveOffset(edits, s.end, 'end') - lead }))
    .map(s => ({ start: Math.max(0, s.start), end: Math.min(body.length, s.end) }))
    .filter(s => s.end > s.start)

  const said = cut.map(s => card.body.slice(s.from, s.to))
  const repeats = (line: string) => said.some(sentence => echoes(line, sentence))
  const bullets = card.bullets.filter(b => !repeats(b))
  if (!body || !bullets.length || repeats(card.summary)) return null
  return { summary: card.summary, bullets, body, sourceIds: card.sourceIds.filter((_, i) => !drop.includes(i + 1)), inferenceSpans }
}
