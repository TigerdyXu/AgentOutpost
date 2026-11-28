/**
 * 专题 (M2.3, design §5.6): one question looked into across some of a track's products. A round is a research session
 * (`topic`, prompts/topic.md) that hands its conclusion cards into a draft, then a check session (`topicCheck`, the
 * dossier's checker and prompt, on the draft's cards), then the dossier's rule on what the check found: a sentence resting
 * only on void sources is cut, a card with no valid source is dropped. What is left becomes the topic's next version; when
 * nothing is left, or either session did not run to its end, the round is rejected and says why.
 *
 * A weekly topic gets a round once its newest version is 7 days old, after the day's brief, maps and weekly
 * suggestions; one that did not finish is tried again the next day, once a day (`topicDue`).
 */
import { localDate, shiftDate } from '../../core/calendar.ts'
import { say } from '../../core/messages.ts'
import type { Id, Topic, TopicCard, TopicVersion } from '../../core/types.ts'
import type { Repo } from '../../store/repo.ts'
import { renderPrompt } from '../prompts.ts'
import { researchTools } from '../tools.ts'
import type { JobDeps } from './runner.ts'
import { sourceVerdicts, STOPPED_EARLY, withoutVoidClaims } from './verify.ts'

/** A weekly topic gets a new round this many days after its newest version. */
export const TOPIC_EVERY_DAYS = 7
/**
 * After this many rounds in a row with no version (each one ¥1–2), the topic is not tried again by itself: the question
 * may be one the web cannot answer with checkable sources. 「立即更新」 still runs a round.
 */
export const TOPIC_MAX_MISSES = 3
/** What a version changed, as the page shows it: the researcher's last words, cut to this many characters. */
const CHANGE_NOTE_MAX = 60

const chars = (text: string) => [...text]

/** The topic's products that still exist, in its order. */
const productsOf = (repo: Repo, topic: Topic) => topic.productIds.flatMap(id => repo.getProduct(id) ?? [])

/**
 * Runs one round of the topic, counted toward `date`: research, check, and the next version if anything held. Resolves
 * with the version written, or null when the round was rejected (the draft says why) or could not start.
 * @throws When the topic does not exist.
 */
export async function runTopic(deps: JobDeps, topicId: Id, date: string): Promise<TopicVersion | null> {
  const { repo, runner, clock, icons } = deps
  const topic = repo.getTopic(topicId)
  if (!topic) throw new Error(`Unknown topic ${topicId}`)
  const products = productsOf(repo, topic)
  const previous = repo.latestTopicVersion(topic.id)
  const draft = repo.addTopicDraft(topic.id)
  // The topic (and its draft) may be deleted while the round runs: then there is nothing to write.
  const reject = (why: string) => { if (repo.getTopicVersion(draft.id)) repo.updateTopicVersion(draft.id, { status: 'rejected', changeNote: why }); return null }
  if (!products.length) return reject(say('topicNoProducts'))

  let summary = ''
  const scope = { trackId: topic.trackId, date, subject: topic.question }
  const research = await runner.session('topic', scope, runId => {
    repo.updateTopicVersion(draft.id, { runId })
    return {
      title: `前哨 · 专题 ${chars(topic.question).slice(0, 20).join('')}`,
      prompt: renderPrompt('topic', {
        question: topic.question,
        products: products.map(p => `${p.name}（${p.company}）`).join('、'),
        today: date,
        round: previous ? `第 ${previous.version! + 1} 版：上一版是 ${dayOf(previous.createdAt)} 的第 ${previous.version} 版，这次在它的基础上更新` : '第一版',
      }),
      tools: onDone => researchTools('topic', {
        repo, runId, trackId: topic.trackId, productId: null, topicId: topic.id, draftId: draft.id, now: () => clock.now(), icons,
        onDone: text => { summary = text; onDone(text) },
      }),
    }
  })
  if (research.status !== 'done') return reject(research.error ?? say('runFailed'))
  if (research.error !== null) return reject(STOPPED_EARLY)
  const handedIn = repo.getTopicVersion(draft.id)
  if (!handedIn) return null // deleted meanwhile
  if (!handedIn.cards.length) return reject(say('topicNoCards'))

  const companies = [...new Set(products.map(p => p.company).filter(Boolean))]
  const check = await runner.session('topicCheck', scope, runId => ({
    title: `前哨 · 专题核查 ${chars(topic.question).slice(0, 20).join('')}`,
    // The dossier's checker, told the topic in place of one product: whose own pages count as official is these companies'.
    prompt: renderPrompt('verify', {
      productName: `专题「${topic.question}」涉及的产品`,
      company: companies.join('、') || '这些产品的公司',
      officialDomains: [...new Set(products.flatMap(p => p.officialDomains))].join('、') || '（未知）',
      today: date,
    }),
    tools: onDone => researchTools('topicCheck', {
      repo, runId, trackId: topic.trackId, productId: null, topicId: topic.id, draftId: draft.id, now: () => clock.now(), icons, onDone,
    }),
  }))
  if (check.status !== 'done') return reject(check.error ?? say('checkFailed'))
  if (check.error !== null) return reject(STOPPED_EARLY)

  const names = products.flatMap(p => [p.name, p.company])
  const kept: TopicCard[] = handedIn.cards.flatMap(card => {
    const { removed, valid } = sourceVerdicts(repo, card.sourceIds)
    if (!valid.length) return []
    const text = withoutVoidClaims(card, removed, valid, names)
    return text ? [{ ...card, ...text }] : []
  })
  if (!kept.length) return reject(say('topicNothingHeld'))
  if (!repo.getTopicVersion(draft.id)) return null // deleted while it was checked
  const note = chars(summary.trim()).slice(0, CHANGE_NOTE_MAX).join('') || say(previous ? 'topicUpdated' : 'topicFirst')
  const written = repo.updateTopicVersion(draft.id, { status: 'final', version: (previous?.version ?? 0) + 1, cards: kept, changeNote: note })
  // The sources the check made it drop (void ones, those of cards dropped whole) are cited by nothing now.
  const still = new Set(kept.flatMap(card => card.sourceIds))
  repo.pruneSources(handedIn.cards.flatMap(card => card.sourceIds).filter(id => !still.has(id)))
  return written
}

/** How a weekly topic stands on `today` (as `weeklyState` says it of a track's suggestions). */
export interface TopicSchedule {
  /** The day of its newest version, or null. */
  last: string | null
  /** The day the next round is due, or null for a one-off topic that has a version, or one that gave up. */
  next: string | null
  /** It made no version `TOPIC_MAX_MISSES` rounds in a row, and is not tried again by itself. */
  gaveUp: boolean
}

/**
 * When the topic's next round is due. A one-off topic is due only until it has a version (its first round, tried again
 * the next day if it did not finish); a weekly one `TOPIC_EVERY_DAYS` after its newest version. One try a day; `dayOver`
 * (today's daily run is through) moves what is due now to tomorrow, as the page says it.
 */
export function topicSchedule(repo: Repo, topic: Topic, today: string, dayOver = false): TopicSchedule {
  const rounds = repo.topicVersions(topic.id)
  const latest = repo.latestTopicVersion(topic.id)
  const last = latest ? dayOf(latest.createdAt) : null
  const misses = rounds.slice(latest ? rounds.findIndex(r => r.id === latest.id) + 1 : 0).filter(r => r.status === 'rejected').length
  const gaveUp = misses >= TOPIC_MAX_MISSES
  if ((topic.cadence === 'once' && latest) || gaveUp) return { last, next: null, gaveUp }
  const due = last === null ? today : shiftDate(last, TOPIC_EVERY_DAYS)
  const triedToday = rounds.some(r => dayOf(r.createdAt) === today)
  return { last, next: due > today ? due : dayOver || triedToday ? shiftDate(today, 1) : today, gaveUp }
}

/** The local day of an instant. */
const dayOf = (iso: string) => localDate(new Date(iso))

/** Whether the topic should get a round now, after the day on `today` is through. */
export function topicDue(repo: Repo, topic: Topic, today: string): boolean {
  const { next } = topicSchedule(repo, topic, today)
  return next !== null && next <= today
}
