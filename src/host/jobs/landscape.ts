/**
 * A track's map and its one-sentence 格局 (M2.1, design §5.5): one call to the brief's model (as the brief's gist is
 * written), reading the track's dossiers (each card's summary and bullets, for the track's dimensions) and placing each
 * product on two axes, in a `landscape` run that carries its cost. Nothing is searched: the map is the model's reading of
 * what the dossiers already hold, shown as an inference.
 *
 * The axes stay put: the first drawing proposes them, and every later one is told to keep them, so that where a product
 * moved means something; only the user changes them (换轴), which starts the trail again. Each later drawing is told
 * where every product stood last time and which of them had a card change since, and to move only those.
 *
 * Drawn after each day's brief when something changed since the last drawing (`needsDrawing`), and when the user asks.
 */
import { costOf } from '../../core/cost.ts'
import { say } from '../../core/messages.ts'
import { modelFor, type ModelSettings } from '../../core/models.ts'
import type { Axes, CardVersion, Id, Landscape, Placement, Product, Track } from '../../core/types.ts'
import type { Repo } from '../../store/repo.ts'
import type { Clock, ModelClient } from '../ports.ts'
import { renderPrompt } from '../prompts.ts'
import { budgetRefusal, STOPPED_ERROR, type RuntimeSettings } from './runner.ts'

export interface LandscapeDeps {
  repo: Repo
  /** Writes with the brief's model (`modelFor('brief')`). */
  model: ModelClient
  clock: Clock
  settings: () => Pick<RuntimeSettings, 'dailyBudgetYuan' | 'billingFor' | 'pricesOf'> & ModelSettings
  /** Aborts when Outpost stops: a drawing under way is given up at once. */
  stop?: AbortSignal
}

/** A map needs at least this many products to place. */
export const MAP_MIN_PRODUCTS = 2
/** The 格局 is at most this many characters (code points). */
export const MAP_GIST_MAX = 60
/** Each end of an axis is at most this many characters. */
export const AXIS_LABEL_MAX = 12
/** Why a product stands where it does: cut to this many characters. */
export const WHY_MAX = 40
const TIMEOUT_MS = 2 * 60_000

const chars = (text: string) => [...text].length

/** A product the map places, with the newest card of each of the track's dimensions it has. */
export interface Mapped { product: Product; cards: CardVersion[] }

/**
 * The products a map of the track places, in the track's order: those followed (tracked or paused) that have a card of
 * at least one of the track's dimensions. One still in 建档中 waits for its dossier.
 */
export function mappable(repo: Repo, track: Track): Mapped[] {
  const keys = new Set(track.dimensions.map(d => d.key))
  return repo.productsOfTrack(track.id).flatMap(product => {
    if (product.status !== 'tracking' && product.status !== 'paused') return []
    const cards = repo.latestCards(product.id).filter(c => keys.has(c.dimension))
    return cards.length ? [{ product, cards }] : []
  })
}

/**
 * Whether the track's map is worth drawing again: it can be drawn (`MAP_MIN_PRODUCTS`), and there is no drawing yet, the
 * products to place are not those of the newest drawing, or one of their cards changed since.
 */
export function needsDrawing(repo: Repo, track: Track): boolean {
  const items = mappable(repo, track)
  if (items.length < MAP_MIN_PRODUCTS) return false
  const latest = repo.latestLandscape(track.id)
  if (!latest) return true
  const placed = new Set(latest.positions.map(p => p.productId))
  if (placed.size !== items.length || items.some(item => !placed.has(item.product.id))) return true
  return items.some(item => item.cards.some(c => c.createdAt > latest.createdAt))
}

/**
 * Draws the track's map for `date` and keeps it. `axes` are the user's (换轴); without them the newest drawing's axes
 * are kept, and the first drawing has the model propose them. Returns the drawing, or null when none was made: too few
 * products (no run), the day's budget spent, the call failed or was cut short, or its answer could not be used (the run
 * says which).
 * @throws When the track does not exist.
 */
export async function drawLandscape(deps: LandscapeDeps, trackId: Id, date: string, axes: Axes | null = null): Promise<Landscape | null> {
  const { repo, model, clock, settings } = deps
  const track = repo.listTracks().find(t => t.id === trackId)
  if (!track) throw new Error(`Unknown track ${trackId}`)
  const items = mappable(repo, track)
  if (items.length < MAP_MIN_PRODUCTS) return null
  const latest = repo.latestLandscape(trackId)
  const fixed = axes ?? latest?.axes ?? null

  const run = repo.createRun({ kind: 'landscape', date, trackId, productId: null })
  const end = (patch: Parameters<Repo['updateRun']>[1]) => { repo.updateRun(run.id, { endedAt: clock.now().toISOString(), ...patch }) }
  const writer = modelFor('brief', settings())
  const refused = budgetRefusal(repo, settings(), writer, date, null)
  if (refused) {
    end({ status: 'skipped', error: refused })
    return null
  }
  repo.updateRun(run.id, { status: 'running', startedAt: clock.now().toISOString() })
  try {
    // The user's own axes start the trail again: the last positions were on other axes.
    const previous = axes ? null : latest
    const user = describeTrack(track, items, date, fixed, previous)
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const { text, usage } = await model.complete({ system: renderPrompt('landscape', {}), user }, deps.stop ? AbortSignal.any([timeout, deps.stop]) : timeout)
    const cost = costOf(usage, settings().pricesOf(writer, clock.now()))
    const drawn = parseLandscape(text, items.map(item => item.product.id), fixed)
    if (!drawn) {
      end({ status: 'done', usage, costYuan: cost, error: say('unusableMap', { max: MAP_GIST_MAX }) })
      return null
    }
    const landscape = repo.addLandscape({ trackId, date, gist: drawn.gist, axes: drawn.axes, positions: drawn.positions, runId: run.id })
    end({ status: 'done', usage, costYuan: cost, error: null })
    return landscape
  } catch (error) {
    end({ status: 'failed', error: deps.stop?.aborted ? STOPPED_ERROR : error instanceof Error ? error.message : String(error) })
    return null
  }
}

/** The user message: the track, the fixed axes if any, and each product as P1, P2, … with its cards (and last position). */
export function describeTrack(track: Track, items: Mapped[], date: string, fixed: Axes | null, previous: Landscape | null): string {
  const labels = new Map(track.dimensions.map(d => [d.key, d.label]))
  const order = new Map(track.dimensions.map((d, i) => [d.key, i]))
  const lines = [`赛道：${track.name}`, `关注：${track.brief || '（没写）'}`, `关注的维度：${track.dimensions.map(d => d.label).join('、')}`, `今天：${date}`, '']
  if (fixed) lines.push('固定的两条轴（原样照用，不要换）：', `- 横轴：${fixed.x.low} ↔ ${fixed.x.high}`, `- 纵轴：${fixed.y.low} ↔ ${fixed.y.high}`, '')
  lines.push('产品：')
  items.forEach(({ product, cards }, i) => {
    lines.push(`P${i + 1} ${product.name}（${product.company || '公司不详'}）${product.status === 'paused' ? '（已暂停跟踪，档案停在暂停时）' : ''}`)
    const last = previous?.positions.find(p => p.productId === product.id)
    if (last) {
      lines.push(`  上次的位置：x=${last.x}, y=${last.y}`)
      const changed = cards.filter(c => c.createdAt > previous!.createdAt).map(c => labels.get(c.dimension) ?? c.dimension)
      if (changed.length) lines.push(`  最近改过：${changed.join('、')}`)
    } else if (previous) {
      lines.push('  上次没有它（新加进来的）')
    }
    for (const card of [...cards].sort((a, b) => (order.get(a.dimension) ?? 0) - (order.get(b.dimension) ?? 0))) {
      lines.push(`  - ${labels.get(card.dimension) ?? card.dimension}：${card.summary}${card.bullets.length ? `（${card.bullets.join('；')}）` : ''}`)
    }
  })
  return lines.join('\n')
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const label = (value: unknown): string | null => {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && chars(text) <= AXIS_LABEL_MAX ? text : null
}
const axisOf = (value: unknown) => {
  if (!isRecord(value)) return null
  const low = label(value.low)
  const high = label(value.high)
  return low && high ? { low, high } : null
}
const coordinate = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(-100, Math.min(100, Math.round(value))) : null

/**
 * The model's answer as a drawing of the products `ids` (P1 is `ids[0]`): the JSON object in it (a code fence or words
 * around it are skipped), with the 格局 trimmed and at most `MAP_GIST_MAX` characters, the axes (`fixed` when given,
 * whatever the answer says; else the answer's, each end 1 to `AXIS_LABEL_MAX` characters), and one position per product,
 * each coordinate rounded into -100…100 and the why cut to `WHY_MAX`. Null when any of that is missing or malformed, or a
 * product is placed twice, missing, or not one of `ids`.
 */
export function parseLandscape(text: string, ids: Id[], fixed: Axes | null): { gist: string; axes: Axes; positions: Placement[] } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) return null
  let value: unknown
  try { value = JSON.parse(text.slice(start, end + 1)) } catch { return null }
  if (!isRecord(value)) return null

  const gist = typeof value.gist === 'string' ? value.gist.trim().replace(/\s*[\r\n]+\s*/g, ' ') : ''
  if (!gist || chars(gist) > MAP_GIST_MAX) return null

  let axes = fixed
  if (!axes) {
    if (!isRecord(value.axes)) return null
    const x = axisOf(value.axes.x)
    const y = axisOf(value.axes.y)
    if (!x || !y) return null
    axes = { x, y }
  }

  if (!Array.isArray(value.positions)) return null
  const byId = new Map<Id, Placement>()
  for (const entry of value.positions) {
    if (!isRecord(entry) || typeof entry.id !== 'string') return null
    const n = /^P(\d+)$/i.exec(entry.id.trim())
    const productId = n ? ids[Number(n[1]) - 1] : undefined
    const x = coordinate(entry.x)
    const y = coordinate(entry.y)
    if (productId === undefined || byId.has(productId) || x === null || y === null) return null
    const why = typeof entry.why === 'string' ? [...entry.why.trim()].slice(0, WHY_MAX).join('') : ''
    byId.set(productId, { productId, x, y, why })
  }
  if (byId.size !== ids.length) return null
  return { gist, axes, positions: ids.map(id => byId.get(id)!) }
}
