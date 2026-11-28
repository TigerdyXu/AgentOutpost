/**
 * The weekly recap of a track (M3.4): what its week (Monday to Sunday, local days) held, read from what Outpost stored,
 * and, once the week is over, one paragraph by the brief's model on top. The lists cost nothing and can be read for any
 * week; the paragraph is written once per track and week, after the first daily run of the next week (`recapDue`), within
 * the day's budget, as a `recap` run.
 */
import { localDate, shiftDate } from '../../core/calendar.ts'
import { costOf } from '../../core/cost.ts'
import { FOLLOWED } from '../../core/identity.ts'
import { say } from '../../core/messages.ts'
import { modelFor, type ModelSettings } from '../../core/models.ts'
import type { FindingStatus, Id, Importance, Recap, Track } from '../../core/types.ts'
import type { Repo } from '../../store/repo.ts'
import type { Clock, ModelClient } from '../ports.ts'
import { renderPrompt } from '../prompts.ts'
import { sameAxes } from './landscape.ts'
import { budgetRefusal, STOPPED_ERROR, type RuntimeSettings } from './runner.ts'

/** The paragraph's limit, in characters. */
export const RECAP_GIST_MAX = 150
/** How far a product must move on either axis of the map (of -100…100) to be named as having moved. */
const MOVE_MIN = 15
const TIMEOUT_MS = 2 * 60_000

/** The Monday (local date) of the week `date` is in. */
export function weekStart(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay() // 0 Sunday … 6 Saturday
  return shiftDate(date, -((day + 6) % 7))
}

/** The local day of a stored time. */
const dayOf = (iso: string) => localDate(new Date(iso))

/** Local midnight at the start of `date`, as a stored time (ISO): a day's bound in the store's terms. */
const midnight = (date: string) => { const [y, m, d] = date.split('-').map(Number); return new Date(y!, m! - 1, d!).toISOString() }

export interface RecapView {
  track: { id: Id; name: string }
  /** The week's Monday and Sunday. */
  week: string
  end: string
  /** Whether the week is over (its Sunday is before today); an open one is 「本周到目前」. */
  complete: boolean
  /** The AI's paragraph, once written. */
  gist: string | null
  /** Verified (or 「待确认」) findings of the week marked major or notable, most important first, then newest. */
  findings: { id: Id; productId: Id; product: string; date: string; importance: Importance; status: FindingStatus; headline: string; why: string }[]
  /** How many minor ones there were besides. */
  minor: number
  /** Dossier cards that took a new version in the week (a first profile aside), newest first. */
  cardChanges: { productId: Id; product: string; dimension: string; label: string; changeNote: string; date: string }[]
  /** Products whose dossier was first built in the week. */
  newProducts: { id: Id; name: string }[]
  /** The newest map drawn in the week, and the products that moved since the last drawing before it (same axes). */
  map: { date: string; gist: string; moved: string[] } | null
  /** Topics that got a new version in the week. */
  topics: { id: Id; question: string; version: number; changeNote: string; date: string }[]
  /**
   * Products with no finding at all in the week: those whose dossier was built by its end, and not first built in it
   * (one being profiled has no findings yet; one added to the track later was not in it).
   */
  quiet: string[]
  /**
   * The weeks before and after (null at either end: the week the track was made, this week). Products are the track's
   * own today; one added to it later is left out of weeks before its dossier was built.
   */
  prev: string | null
  next: string | null
  /** A week just over whose paragraph is still to come: due at this week's first daily run. */
  gistDue: boolean
}

const RANK: Record<Importance, number> = { major: 0, notable: 1, minor: 2 }

/** The recap of the track's week `week` (a Monday) as of `today`. */
export function composeRecap(repo: Repo, track: Track, week: string, today: string): RecapView {
  const end = shiftDate(week, 6)
  // The week's bounds as stored times: only what was written in it is read (not every product's whole history).
  const from = midnight(week)
  const to = midnight(shiftDate(week, 7))
  const within = (iso: string) => iso >= from && iso < to
  const products = repo.productsOfTrack(track.id).filter(p => FOLLOWED.includes(p.status))
  const labels = new Map(track.dimensions.map(d => [d.key, d.label]))
  const findings: RecapView['findings'] = []
  let minor = 0
  const cardChanges: RecapView['cardChanges'] = []
  const newProducts: RecapView['newProducts'] = []
  const quiet: string[] = []
  for (const product of products) {
    const profiled = repo.firstCardAt(product.id)
    if (profiled !== null && profiled >= to) continue // not in the track's work yet that week
    const ofWeek = repo.findingsBetween(product.id, from, to).filter(f => f.status === 'verified' || f.status === 'unconfirmed')
    const isNew = profiled !== null && within(profiled)
    if (isNew) newProducts.push({ id: product.id, name: product.name })
    else if (!ofWeek.length && profiled !== null) quiet.push(product.name)
    for (const f of ofWeek) {
      if (f.importance === 'minor') { minor++; continue }
      findings.push({ id: f.id, productId: product.id, product: product.name, date: dayOf(f.createdAt), importance: f.importance, status: f.status, headline: f.headline, why: f.why })
    }
    for (const version of repo.cardVersionsBetween(product.id, from, to)) {
      const label = labels.get(version.dimension)
      if (version.version === 1 || label === undefined) continue // a first card is the profile, not a change; another track's dimension is not this one's
      cardChanges.push({ productId: product.id, product: product.name, dimension: version.dimension, label, changeNote: version.changeNote, date: dayOf(version.createdAt) })
    }
  }
  findings.sort((a, b) => RANK[a.importance] - RANK[b.importance] || b.date.localeCompare(a.date))
  cardChanges.sort((a, b) => b.date.localeCompare(a.date))

  const drawings = repo.landscapesOfTrack(track.id)
  const ofWeek = drawings.filter(d => within(d.createdAt))
  const latest = ofWeek.at(-1)
  let map: RecapView['map'] = null
  if (latest) {
    const before = drawings.filter(d => dayOf(d.createdAt) < week).at(-1)
    const names = new Map(products.map(p => [p.id, p.name]))
    const moved = before && sameAxes(before.axes, latest.axes)
      ? latest.positions.flatMap(now => {
        const then = before.positions.find(p => p.productId === now.productId)
        return then && (Math.abs(now.x - then.x) >= MOVE_MIN || Math.abs(now.y - then.y) >= MOVE_MIN) && names.has(now.productId) ? [names.get(now.productId)!] : []
      })
      : []
    map = { date: latest.date, gist: latest.gist, moved }
  }

  const topics: RecapView['topics'] = repo.topicsOfTrack(track.id).flatMap(topic => repo.topicVersionsBetween(topic.id, from, to)
    .filter(v => v.status === 'final' && v.version !== null && within(v.createdAt))
    .map(v => ({ id: topic.id, question: topic.question, version: v.version!, changeNote: v.changeNote, date: dayOf(v.createdAt) })))

  const thisWeek = weekStart(today)
  const first = weekStart(dayOf(track.createdAt))
  const gist = repo.getRecap(track.id, week)?.gist ?? null
  const view: RecapView = {
    track: { id: track.id, name: track.name }, week, end, complete: end < today, gist,
    findings, minor, cardChanges, newProducts, map, topics, quiet,
    prev: week > first ? shiftDate(week, -7) : null,
    next: week < thisWeek ? shiftDate(week, 7) : null,
    gistDue: false,
  }
  // Last week, over, with something to say and no paragraph yet: this week's daily run will write it (`recapDue`).
  view.gistDue = gist === null && shiftDate(week, 7) === thisWeek && track.status === 'active' && dayOf(track.createdAt) <= end && hasNews(view)
  return view
}

/** Whether the week held anything to say. */
export const hasNews = (recap: RecapView) =>
  recap.findings.length > 0 || recap.minor > 0 || recap.cardChanges.length > 0 || recap.newProducts.length > 0 || recap.map !== null || recap.topics.length > 0

/** The week's material as the model reads it. */
export function describeWeek(track: Track, recap: RecapView): string {
  const head = [`赛道：${track.name}`, `关注：${track.brief || '（没写）'}`, `上周：${recap.week} 到 ${recap.end}`].join('\n')
  if (!hasNews(recap)) return `${head}\n\n这周没有新东西。`
  const level: Record<Importance, string> = { major: '重大', notable: '值得注意', minor: '小更新' }
  const sections: string[][] = []
  if (recap.findings.length || recap.minor) {
    sections.push([
      ...recap.findings.length ? ['重要发现：', ...recap.findings.map(f => `- ${f.product}（${f.date.slice(5)}，${level[f.importance]}${f.status === 'unconfirmed' ? '，待确认' : ''}）${f.headline}：${f.why}`)] : [],
      ...recap.minor ? [`另有 ${recap.minor} 条小更新。`] : [],
    ])
  }
  if (recap.cardChanges.length) sections.push(['档案改了的地方：', ...recap.cardChanges.map(c => `- ${c.product} · ${c.label}：${c.changeNote}`)])
  if (recap.newProducts.length) sections.push([`新建档的产品：${recap.newProducts.map(p => p.name).join('、')}`])
  if (recap.map) sections.push([`定位地图（${recap.map.date.slice(5)}）的格局：${recap.map.gist}`, ...recap.map.moved.length ? [`挪了位置：${recap.map.moved.join('、')}`] : []])
  if (recap.topics.length) sections.push(['专题的新版本：', ...recap.topics.map(t => `- ${t.question}（第 ${t.version} 版）：${t.changeNote}`)])
  if (recap.quiet.length) sections.push([`整周没动静：${recap.quiet.join('、')}`])
  return [head, ...sections.map(lines => lines.join('\n'))].join('\n\n')
}

/** The model's answer as the paragraph: quotes and a leading 「总结：」 removed, lines joined; null when empty or too long. */
export function parseRecapGist(text: string): string | null {
  const edges = /^[\s"'“”「」『』]+|[\s"'“”「」『』]+$/gu
  const gist = text.replace(edges, '').replace(/^(?:上周回顾|总结|回顾)[:：]\s*/u, '').replace(edges, '').replace(/\s*[\r\n]+\s*/g, '').trim()
  return gist && [...gist].length <= RECAP_GIST_MAX ? gist : null
}

export interface RecapDeps {
  repo: Repo
  model: ModelClient
  clock: Clock
  settings: () => Pick<RuntimeSettings, 'dailyBudgetYuan' | 'billingFor' | 'pricesOf'> & ModelSettings
  stop?: AbortSignal
}

/**
 * Writes the paragraph of the track's week `week`, on `date`'s budget, as a `recap` run; returns it, or null when none was
 * written (the budget spent, the call failed or was cut short, or the answer could not be used: the run says which).
 */
export async function writeRecap(deps: RecapDeps, trackId: Id, week: string, date: string): Promise<Recap | null> {
  const { repo, model, clock, settings } = deps
  const track = repo.listTracks().find(t => t.id === trackId)
  if (!track) throw new Error(`Unknown track ${trackId}`)
  const recap = composeRecap(repo, track, week, date)
  // The week goes in `subject`, so that a retry on another day writes the same one.
  const run = repo.createRun({ kind: 'recap', date, trackId, productId: null, subject: week })
  const end = (patch: Parameters<Repo['updateRun']>[1]) => { repo.updateRun(run.id, { endedAt: clock.now().toISOString(), ...patch }) }
  const writer = modelFor('brief', settings())
  const refused = budgetRefusal(repo, settings(), writer, date, null)
  if (refused) {
    end({ status: 'skipped', error: refused })
    return null
  }
  repo.updateRun(run.id, { status: 'running', startedAt: clock.now().toISOString() })
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const { text, usage } = await model.complete({ system: renderPrompt('recap', {}), user: describeWeek(track, recap) }, deps.stop ? AbortSignal.any([timeout, deps.stop]) : timeout)
    const cost = costOf(usage, settings().pricesOf(writer, clock.now()))
    const gist = parseRecapGist(text)
    if (!gist) {
      end({ status: 'done', usage, costYuan: cost, error: say('unusableRecap', { max: RECAP_GIST_MAX }) })
      return null
    }
    const kept = repo.putRecap({ trackId, week, gist, runId: run.id })
    end({ status: 'done', usage, costYuan: cost, error: null })
    return kept
  } catch (error) {
    end({ status: 'failed', error: deps.stop?.aborted ? STOPPED_ERROR : error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * The week whose paragraph is due on `date` for the track, or null: the week before `date`'s, when the track already
 * existed by its end, the week held something, it has no paragraph yet, and no recap run of the track went on `date`
 * (one try a day; a week not written by its next Sunday stays without one).
 */
export function recapDue(repo: Repo, track: Track, date: string): string | null {
  if (track.status !== 'active') return null
  const week = shiftDate(weekStart(date), -7)
  if (dayOf(track.createdAt) > shiftDate(week, 6) || repo.getRecap(track.id, week)) return null
  if (repo.runsOfDate(date, 'recap').some(r => r.trackId === track.id && r.subject === week)) return null
  return hasNews(composeRecap(repo, track, week, date)) ? week : null
}
