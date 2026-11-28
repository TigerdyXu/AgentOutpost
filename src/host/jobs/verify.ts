/**
 * The check (design §7.4, §7.5, §8). A `verify` session 「前哨 · <产品> 核查」 opens every source of what waits for a check
 * and reports what it saw (`outpost_report_check`), adding a corroborating source where a finding lacks one. The verdict
 * is then the code's, not the agent's: `judge` decides every pending and unconfirmed finding from those reports, and
 * the card edits are merged by the rules below. Only verified material reaches the dossier, as a new card version.
 */
import { localDate } from '../../core/calendar.ts'
import { applyCardEdit } from '../../core/cards.ts'
import { isOwnSource, isValidEvidence, isVoidEvidence, judge, type Evidence } from '../../core/credibility.ts'
import type { CardEdit, Finding, Id, Run, Source, Span } from '../../core/types.ts'
import type { Repo } from '../../store/repo.ts'
import { renderPrompt } from '../prompts.ts'
import { researchTools } from '../tools.ts'
import type { JobDeps } from './runner.ts'
import { say } from '../../core/messages.ts'
import { sessionTitle } from '../titles.ts'

export type VerifyScope = 'baseline' | 'daily'

/** The note of a finding that was 「待确认」 and has now been confirmed (design §7.4: it shows as 「已证实」). */
export const PROMOTED_NOTE = say('promoted')

/** Why a check whose session ended without `outpost_done` (out of room, or it just stopped) decides nothing. */
export const STOPPED_EARLY = say('stoppedEarly')

/**
 * The check did not run to its end, so nothing was judged: its run was skipped (budget), failed (error, time-out, stop),
 * or ended without `outpost_done` (then it is recorded as failed).
 */
export class VerifyNotRun extends Error {
  /** @param run - the `verify` run as it ended; its `error` is the reason. */
  constructor(readonly run: Run) {
    super(run.error ?? (run.status === 'skipped' ? say('checkSkipped') : say('checkFailed')))
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
    title: scope === 'baseline' ? sessionTitle(repo, 'baselineCheck', { name: product.name }) : sessionTitle(repo, 'verify', { name: product.name, date: day }),
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
  const product = repo.getProduct(edit.productId)
  const kept = valid.length ? withoutVoidClaims(edit, removed, valid, product ? [product.name, product.company] : []) : null
  if (!kept) repo.setCardEditStatus(edit.id, 'rejected')
  else write(repo, edit, kept, now)
}

/** The edit's sources that the check found void, and those it found valid (1-based, as `[n]` counts them). */
function sourceCheck(repo: Repo, edit: CardEdit): { removed: number[]; valid: number[] } {
  return sourceVerdicts(repo, edit.sourceIds)
}

/** Of the sources `sourceIds` (a card's, in its `[n]` order), those the check found void and those it found valid, 1-based. */
export function sourceVerdicts(repo: Repo, sourceIds: Id[]): { removed: number[]; valid: number[] } {
  const edit = { sourceIds }
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

/** A source as `judge` sees it: official only as `isOwnSource` says; one nobody reported on counts as not opened (see `verifyProduct`). */
function evidenceOf(s: Source): Evidence {
  const seen = s.openedVia === null
    ? { openedVia: 'unopened' as const, quoteFound: null, supportsClaim: null }
    : { openedVia: s.openedVia, quoteFound: s.quoteFound, supportsClaim: s.supportsClaim }
  return { url: s.url, isOfficial: isOwnSource(s), syndicationGroup: s.syndicationGroup, ...seen }
}

// ---- citations ----

/** A citation in a card body: `[n]`, n counting the card's sources from 1 (the tools allow no other bracketed number). */
const CITATION = /\[(\d+)\]/g

/**
 * Where a sentence of a card body may end: after 。！？ or ；, or after a line break (a line without a full stop, such
 * as a list item). What closes the sentence after the mark (a closing quote or bracket) and the citations written after
 * that go with it (`sentences`).
 */
const STOP = /[。！？；]|\n/g
/** Marks that only ever close: after a stop they belong to the sentence the stop ends (「…。」[2]). */
const CLOSERS = new Set('」』”’）)】》〉')
/** Straight quotes both open and close: after a stop one closes the sentence only if one of its kind is open in it. */
const STRAIGHT_QUOTES = new Set(['"', "'"])
/** Citations written right after a sentence's end (and its closing marks). */
const TRAILING_CITATIONS = /(?:\[\d+\])*/y

/** How many units in a row (`echoUnits`: a character, or a Latin word) a bullet or the summary must share with a dropped sentence to count as repeating it. */
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

/**
 * The sentences of `body`, in order and covering all of it: each ends after a stop (see `STOP`), the closing quotes and
 * brackets right after it, and the citations right after those, so that 「…。」[2] cites the quoted sentence.
 */
function sentences(body: string): Range[] {
  const out: Range[] = []
  let from = 0
  for (const m of body.matchAll(STOP)) {
    if (m.index < from) continue // inside what the sentence before took
    let to = m.index + 1
    if (m[0] !== '\n') {
      for (;;) {
        const c = body[to]
        const closesQuote = c !== undefined && STRAIGHT_QUOTES.has(c) && countOf(body.slice(from, to), c) % 2 === 1
        if (c === undefined || !(CLOSERS.has(c) || closesQuote)) break
        to++
      }
      TRAILING_CITATIONS.lastIndex = to
      to += TRAILING_CITATIONS.exec(body)![0].length
    }
    out.push({ from, to })
    from = to
  }
  if (from < body.length) out.push({ from, to: body.length })
  return out
}

const countOf = (text: string, char: string) => text.split(char).length - 1

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

/**
 * A text in the units the echo test counts: citations gone, full-width forms folded and lower case, then each Latin
 * word or number as written (a run of letters and digits between spaces or marks: 「GPT-4o」 is `gpt` and `4o`) one unit,
 * and any other character one unit; spaces, punctuation and symbols are no units.
 */
const tokens = (text: string): string[] =>
  (text.replace(CITATION, '').normalize('NFKC').toLowerCase().match(/[a-z0-9]+|\S/gu) ?? []).filter(t => !/^[\p{P}\p{S}]$/u.test(t))

/** Where `part` (at least one unit) occurs in `units`, as a run of whole units. */
const runAt = (units: readonly string[], part: readonly string[], from: number) => part.every((t, j) => units[from + j] === t)

/**
 * A text as the echo test compares it, in units (`tokens`), without the product's names (`names`): each name is taken
 * out as whole units, whatever its case, and also written without its spaces (「Perplexity AI」 and 「PerplexityAI」).
 * A name shared with a dropped sentence is no repeat of it.
 */
function echoUnits(text: string, names: readonly string[]): string[] {
  const forms = names.flatMap(name => {
    const units = tokens(name)
    return units.length > 1 ? [units, tokens(units.join(''))] : [units]
  }).filter(units => units.length > 0).sort((a, b) => b.length - a.length)
  const units = tokens(text)
  const out: string[] = []
  for (let i = 0; i < units.length;) {
    const name = forms.find(form => runAt(units, form, i))
    if (name) i += name.length
    else out.push(units[i++]!)
  }
  return out
}

/** Units joined so that a run of them is found only at unit boundaries. */
const joinUnits = (units: readonly string[]) => `\u0000${units.join('\u0000')}\u0000`

/** Whether `line` shares `ECHO_CHARS` or more units in a row with `sentence` (both compared as `echoUnits`). */
function echoes(line: string, sentence: string, names: readonly string[]): boolean {
  const said = joinUnits(echoUnits(sentence, names))
  const units = echoUnits(line, names)
  for (let i = 0; i + ECHO_CHARS <= units.length; i++) if (said.includes(joinUnits(units.slice(i, i + ECHO_CHARS)))) return true
  return false
}

/** The source numbers a line cites (`[n]`). */
const citedIn = (line: string) => [...line.matchAll(CITATION)].map(m => Number(m[1]))

/**
 * A card without what its void sources said (design §2, §8.1: nothing goes into the dossier without a source that backs
 * it). `removed` are the void sources, `valid` the valid ones (1-based); any other source was not seen either way.
 * `names` are the product's name and company, which do not count toward a repeat (below).
 * - Each sentence (split after 。！？； or a line break, with the closing marks and citations right after, see
 *   `sentences`) citing a void source goes, unless it also cites a valid one; there only the void citation goes.
 * - A bullet sharing `ECHO_CHARS` or more units in a row with a dropped sentence (compared without width, case, spaces,
 *   punctuation, citations and the product's names, a Latin word or number counting as one unit, see `echoUnits`) goes
 *   too, and so does a bullet whose every citation is of a void source.
 * - The void sources leave `sourceIds`, and so does any source whose every citation went with a dropped sentence or
 *   bullet; the remaining citations, in the body, the bullets and the summary, are renumbered to close the gaps. The
 *   推论 marks (`inferenceSpans`, UTF-16 offsets into the body) move with the text they cover; one left covering nothing
 *   is dropped.
 * Null, so that the edit is rejected, when the summary repeats a dropped sentence that way, or no bullet or no text is left.
 */
export function withoutVoidClaims(card: CardText, removed: number[], valid: number[], names: readonly string[] = []): CardText | null {
  const citations = citationEdits(card.body, [])
  const isVoid = (n: number) => removed.includes(n)
  const backs = (n: number) => valid.includes(n) && !isVoid(n)
  const cut = sentences(card.body).filter(s => {
    const cited = citations.filter(c => within(c, s)).map(c => c.n)
    return cited.some(isVoid) && !cited.some(backs)
  })
  const said = cut.map(s => card.body.slice(s.from, s.to))
  const repeats = (line: string) => said.some(sentence => echoes(line, sentence, names))
  const keptBullets = card.bullets.filter(b => {
    const cited = citedIn(b)
    return !repeats(b) && !(cited.length && cited.every(isVoid))
  })

  // A source still cited by the body, a bullet that stays or the summary stays; one cited only by what went leaves.
  const kept = [...citations.filter(c => !cut.some(s => within(c, s))).map(c => c.n), ...keptBullets.flatMap(citedIn), ...citedIn(card.summary)]
  const everCited = new Set([...citations.map(c => c.n), ...card.bullets.flatMap(citedIn)])
  const uncited = [...everCited].filter(n => !kept.includes(n))
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

  if (!body || !keptBullets.length || repeats(card.summary)) return null
  return {
    summary: renumberCitations(card.summary, drop), bullets: keptBullets.map(b => renumberCitations(b, drop)), body,
    sourceIds: card.sourceIds.filter((_, i) => !drop.includes(i + 1)), inferenceSpans,
  }
}
