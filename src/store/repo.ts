import { randomUUID } from 'node:crypto'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { localDate } from '../core/calendar.ts'
import type {
  Brief, Candidate, CardEdit, CardVersion, Dimension, Facts, Finding, Id, Product, ProductStatus, Run, RunKind, Source, Track,
} from '../core/types.ts'
import type { Db } from './db.ts'

type Row = Record<string, SQLOutputValue>
/** How a field is kept in its column: as is, as JSON text, or as 0/1. */
type Kind = 'plain' | 'json' | 'bool'
/** Every field of `T`, so that adding one to a domain type without storing it fails to compile. */
type Shape<T> = { readonly [K in keyof T]-?: Kind }

const DAY_MS = 24 * 60 * 60 * 1000
const snake = (name: string) => name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)

/** Maps one domain type to its table: camelCase field names are snake_case columns, `Kind` says how to convert. */
class Codec<T extends object> {
  readonly props: string[]
  constructor(readonly table: string, private readonly shape: Shape<T>) { this.props = Object.keys(shape) }
  columns(): string[] { return this.props.map(snake) }
  encode(prop: string, value: unknown): SQLInputValue {
    if (value === undefined || value === null) return null
    const kind = (this.shape as Record<string, Kind>)[prop]
    return kind === 'json' ? JSON.stringify(value) : kind === 'bool' ? (value ? 1 : 0) : value as SQLInputValue
  }
  decode(row: Row): T {
    const out: Record<string, unknown> = {}
    for (const prop of this.props) {
      const value = row[snake(prop)] ?? null
      const kind = (this.shape as Record<string, Kind>)[prop]
      out[prop] = value === null ? null : kind === 'json' ? JSON.parse(String(value)) : kind === 'bool' ? Number(value) !== 0 : value
    }
    return out as T
  }
}

const TRACK = new Codec<Track>('tracks', { id: 'plain', name: 'plain', brief: 'plain', dimensions: 'json', status: 'plain', createdAt: 'plain' })
const PRODUCT = new Codec<Product>('products', { id: 'plain', name: 'plain', company: 'plain', region: 'plain', form: 'plain', iconPath: 'plain', officialDomains: 'json', status: 'plain', dailyBudgetYuan: 'plain', createdAt: 'plain' })
const CANDIDATE = new Codec<Candidate>('candidates', { id: 'plain', trackId: 'plain', batchId: 'plain', productId: 'plain', tier: 'plain', oneLiner: 'plain', reason: 'plain', heat: 'json', selected: 'bool' })
const SOURCE = new Codec<Source>('sources', { id: 'plain', url: 'plain', title: 'plain', publisher: 'plain', publishedAt: 'plain', kind: 'plain', isOfficial: 'bool', quote: 'plain', syndicationGroup: 'plain', openedVia: 'plain', quoteFound: 'bool', supportsClaim: 'bool' })
const FINDING = new Codec<Finding>('findings', { id: 'plain', productId: 'plain', runId: 'plain', headline: 'plain', why: 'plain', importance: 'plain', claimKind: 'plain', sourceIds: 'json', status: 'plain', statusNote: 'plain', unconfirmedUntil: 'plain', dimensions: 'json', inference: 'bool', read: 'bool', late: 'bool', dedupeKey: 'plain', createdAt: 'plain', verifiedOn: 'plain' })
const CARD_VERSION = new Codec<CardVersion>('card_versions', { productId: 'plain', dimension: 'plain', version: 'plain', summary: 'plain', bullets: 'json', body: 'plain', sourceIds: 'json', inferenceSpans: 'json', addedSpans: 'json', changeNote: 'plain', findingIds: 'json', createdAt: 'plain' })
const CARD_EDIT = new Codec<CardEdit>('card_edits', { id: 'plain', productId: 'plain', dimension: 'plain', summary: 'plain', bullets: 'json', body: 'plain', sourceIds: 'json', inferenceSpans: 'json', changeNote: 'plain', findingIds: 'json', status: 'plain' })
const FACTS = new Codec<Facts>('facts', { productId: 'plain', version: 'plain', form: 'plain', platforms: 'plain', price: 'plain', firstReleased: 'plain', rivals: 'json', createdAt: 'plain' })
const BRIEF = new Codec<Brief>('briefs', { date: 'plain', gist: 'plain', findingIds: 'json', minorIds: 'json', quietProductIds: 'json', skipped: 'json', costYuan: 'plain', createdAt: 'plain', updatedAt: 'plain' })
const RUN = new Codec<Run>('runs', { id: 'plain', kind: 'plain', date: 'plain', trackId: 'plain', productId: 'plain', sessionId: 'plain', status: 'plain', startedAt: 'plain', endedAt: 'plain', usage: 'json', costYuan: 'plain', error: 'plain', progress: 'json' })

type SourcePatch = Partial<Pick<Source, 'openedVia' | 'quoteFound' | 'supportsClaim' | 'syndicationGroup'>>
type FindingPatch = Partial<Pick<Finding, 'status' | 'statusNote' | 'unconfirmedUntil' | 'read' | 'late' | 'sourceIds' | 'verifiedOn'>>
type TrackPatch = Partial<Pick<Track, 'name' | 'brief' | 'dimensions' | 'status'>>

/**
 * Everything Outpost remembers, as typed reads and writes over the SQLite file. Lists come back in insertion order
 * (oldest first) unless a method says otherwise; `createdAt` is stamped here from `now`. Updating a row that does not
 * exist throws. Compound writes that must not be half-done go inside `Db.atomic`.
 */
export class Repo {
  /** @param now - The clock `createdAt` stamps and `findingsOfProduct`'s window read; tests pass their own. */
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  // ---- tracks ----

  createTrack(t: Omit<Track, 'id' | 'createdAt'>): Track {
    const track: Track = { ...t, id: randomUUID(), createdAt: this.stamp() }
    this.insert(TRACK, track)
    return track
  }

  /** @throws When the track does not exist. */
  updateTrack(id: Id, patch: TrackPatch): Track {
    this.patch(TRACK, id, patch, ['name', 'brief', 'dimensions', 'status'])
    return this.require(TRACK, id)
  }

  listTracks(): Track[] { return this.select(TRACK, 'ORDER BY rowid') }

  /** The products linked to the track, in the order they were linked, whatever their status. */
  productsOfTrack(trackId: Id): Product[] {
    return this.select(PRODUCT, 'JOIN track_products tp ON tp.product_id = products.id WHERE tp.track_id = ? ORDER BY tp.rowid', trackId)
  }

  /** The dimensions of every track the product belongs to, merged by key; the first label seen for a key wins. */
  dimensionsOfProduct(productId: Id): Dimension[] {
    const rows = this.db.prepare('SELECT t.dimensions FROM track_products tp JOIN tracks t ON t.id = tp.track_id WHERE tp.product_id = ? ORDER BY tp.rowid').all(productId)
    const merged = new Map<string, Dimension>()
    for (const row of rows) for (const d of JSON.parse(String(row.dimensions)) as Dimension[]) if (!merged.has(d.key)) merged.set(d.key, d)
    return [...merged.values()]
  }

  // ---- products and candidates ----

  /**
   * Adds a product, or refreshes the one that is already there: the same name at the same company (ignoring case and
   * surrounding spaces), or the row `p.id` points at. A refresh keeps `id`, `createdAt` and `status` (status moves only
   * through `setProductStatus`, so meeting a tracked product again in another track never demotes it), updates `region`
   * and `form`, merges `officialDomains`, and does not let a null `iconPath` or `dailyBudgetYuan` erase a value it has.
   * The first spelling of name and company stays unless the row was found by `id`, which may rename it.
   */
  upsertProduct(p: Omit<Product, 'id' | 'createdAt'> & { id?: Id }): Product {
    return this.db.atomic(() => {
      const name = p.name.trim()
      const company = p.company.trim()
      const byId = p.id === undefined ? undefined : this.get(PRODUCT, p.id)
      const existing = byId ?? this.select(PRODUCT, 'WHERE name = ? COLLATE NOCASE AND company = ? COLLATE NOCASE', name, company)[0]
      if (!existing) {
        const created: Product = { ...p, name, company, id: p.id ?? randomUUID(), createdAt: this.stamp() }
        this.insert(PRODUCT, created)
        return created
      }
      const refreshed = {
        ...(byId ? { name, company } : {}),
        region: p.region,
        form: p.form,
        iconPath: p.iconPath ?? existing.iconPath,
        officialDomains: [...new Set([...existing.officialDomains, ...p.officialDomains])],
        dailyBudgetYuan: p.dailyBudgetYuan ?? existing.dailyBudgetYuan,
      }
      this.patch(PRODUCT, existing.id, refreshed, Object.keys(refreshed))
      return { ...existing, ...refreshed }
    })
  }

  getProduct(id: Id): Product | null { return this.get(PRODUCT, id) ?? null }

  setProductStatus(id: Id, status: ProductStatus): void { this.patch(PRODUCT, id, { status }, ['status']) }

  /** Sets where the product's icon file is kept (null clears it); nothing else about the product changes. */
  setProductIcon(id: Id, iconPath: string | null): void { this.patch(PRODUCT, id, { iconPath }, ['iconPath']) }

  /** Puts the product in the track's tracked list; linking twice is harmless. */
  linkProduct(trackId: Id, productId: Id): void {
    this.db.prepare('INSERT OR IGNORE INTO track_products (track_id, product_id) VALUES (?, ?)').run(trackId, productId)
  }

  addCandidate(c: Omit<Candidate, 'id'>): Candidate {
    const candidate: Candidate = { ...c, id: randomUUID() }
    this.insert(CANDIDATE, candidate)
    return candidate
  }

  /** The track's candidates: one batch if `batchId` is given, otherwise all batches. */
  listCandidates(trackId: Id, batchId?: Id): Candidate[] {
    return batchId === undefined
      ? this.select(CANDIDATE, 'WHERE track_id = ? ORDER BY rowid', trackId)
      : this.select(CANDIDATE, 'WHERE track_id = ? AND batch_id = ? ORDER BY rowid', trackId, batchId)
  }

  /** The batch whose candidate was added last, or null when the track has none. */
  latestBatchId(trackId: Id): Id | null {
    const row = this.db.prepare('SELECT batch_id FROM candidates WHERE track_id = ? ORDER BY rowid DESC LIMIT 1').get(trackId)
    return row ? String(row.batch_id) : null
  }

  // ---- sources and findings ----

  addSource(s: Omit<Source, 'id'>): Source {
    const source: Source = { ...s, id: randomUUID() }
    this.insert(SOURCE, source)
    return source
  }

  updateSource(id: Id, patch: SourcePatch): void { this.patch(SOURCE, id, patch, ['openedVia', 'quoteFound', 'supportsClaim', 'syndicationGroup']) }

  /** The sources with those ids, in the order asked; ids that do not exist are skipped. */
  getSources(ids: Id[]): Source[] {
    const unique = [...new Set(ids)]
    if (!unique.length) return []
    const byId = new Map(this.select(SOURCE, `WHERE id IN (${unique.map(() => '?').join(',')})`, ...unique).map(s => [s.id, s]))
    return unique.flatMap(id => byId.get(id) ?? [])
  }

  /** The finding belongs to the day of its run (so a slow run finishing after midnight stays on its own day); with no such run, to the day it was made. */
  addFinding(f: Omit<Finding, 'id' | 'createdAt'>): Finding {
    const created = this.now()
    const finding: Finding = { ...f, id: randomUUID(), createdAt: created.toISOString() }
    const run = this.db.prepare('SELECT date FROM runs WHERE id = ?').get(f.runId)
    this.insert(FINDING, finding, { date: run ? String(run.date) : localDate(created) })
    return finding
  }

  getFinding(id: Id): Finding | null { return this.get(FINDING, id) ?? null }

  updateFinding(id: Id, patch: FindingPatch): void { this.patch(FINDING, id, patch, ['status', 'statusNote', 'unconfirmedUntil', 'read', 'late', 'sourceIds', 'verifiedOn']) }

  /** The findings of that day's brief (see `addFinding`), oldest first. */
  findingsOfDate(date: string): Finding[] { return this.select(FINDING, 'WHERE date = ? ORDER BY rowid', date) }

  /** The findings verified on that day (`verifiedOn`), oldest first, whichever day's brief they belong to: how a promotion reaches the brief of its day. */
  findingsVerifiedOn(date: string): Finding[] { return this.select(FINDING, 'WHERE verified_on = ? ORDER BY rowid', date) }

  /**
   * The product's findings, newest first, whatever their status. With `sinceDays`, only those made within that many
   * 24-hour periods before now (the boundary counts); 0 means from this instant on.
   * @throws RangeError for a negative or non-finite `sinceDays`.
   */
  findingsOfProduct(productId: Id, sinceDays?: number): Finding[] {
    if (sinceDays === undefined) return this.select(FINDING, 'WHERE product_id = ? ORDER BY rowid DESC', productId)
    if (!Number.isFinite(sinceDays) || sinceDays < 0) throw new RangeError(`sinceDays must be a non-negative number, got ${sinceDays}`)
    const since = new Date(this.now().getTime() - sinceDays * DAY_MS).toISOString()
    return this.select(FINDING, 'WHERE product_id = ? AND created_at >= ? ORDER BY rowid DESC', productId, since)
  }

  /**
   * The product's findings still marked `unconfirmed`, oldest first. This does not look at the deadline: re-checking
   * one that is past it is how it becomes `unproven`.
   */
  openUnconfirmed(productId: Id): Finding[] {
    return this.select(FINDING, "WHERE product_id = ? AND status = 'unconfirmed' ORDER BY rowid", productId)
  }

  // ---- cards and facts ----

  /** The newest version of each dimension that has a card, dimensions in the order they first got one. */
  latestCards(productId: Id): CardVersion[] {
    return this.select(CARD_VERSION, `JOIN (SELECT dimension AS d, MAX(version) AS v, MIN(rowid) AS first_seen FROM card_versions WHERE product_id = ? GROUP BY dimension) latest
      ON card_versions.dimension = latest.d AND card_versions.version = latest.v WHERE card_versions.product_id = ? ORDER BY latest.first_seen`, productId, productId)
  }

  /** Every version of one dimension's card, oldest first. */
  cardHistory(productId: Id, dimension: string): CardVersion[] {
    return this.select(CARD_VERSION, 'WHERE product_id = ? AND dimension = ? ORDER BY version', productId, dimension)
  }

  /** Appends a version; the caller numbers it. @throws When that product, dimension and version already exist. */
  addCardVersion(v: CardVersion): void { this.insert(CARD_VERSION, v) }

  addCardEdit(e: Omit<CardEdit, 'id' | 'status'>): CardEdit {
    const edit: CardEdit = { ...e, id: randomUUID(), status: 'pending' }
    this.insert(CARD_EDIT, edit)
    return edit
  }

  pendingCardEdits(productId: Id): CardEdit[] { return this.select(CARD_EDIT, "WHERE product_id = ? AND status = 'pending' ORDER BY rowid", productId) }

  setCardEditStatus(id: Id, status: CardEdit['status']): void { this.patch(CARD_EDIT, id, { status }, ['status']) }

  latestFacts(productId: Id): Facts | null { return this.select(FACTS, 'WHERE product_id = ? ORDER BY version DESC LIMIT 1', productId)[0] ?? null }

  /** Stores the next version of the product's facts. */
  addFacts(f: Omit<Facts, 'version' | 'createdAt'>): Facts {
    return this.db.atomic(() => {
      const last = this.db.prepare('SELECT MAX(version) AS v FROM facts WHERE product_id = ?').get(f.productId)
      const facts: Facts = { ...f, version: Number(last?.v ?? 0) + 1, createdAt: this.stamp() }
      this.insert(FACTS, facts)
      return facts
    })
  }

  // ---- briefs and runs ----

  getBrief(date: string): Brief | null { return this.select(BRIEF, 'WHERE date = ?', date)[0] ?? null }

  /** Saves the brief as given, replacing any earlier one for its date. */
  putBrief(b: Brief): void { this.insert(BRIEF, b, {}, 'INSERT OR REPLACE') }

  createRun(r: Pick<Run, 'kind' | 'date' | 'trackId' | 'productId'>): Run {
    const run: Run = {
      ...r, id: randomUUID(), sessionId: null, status: 'queued', startedAt: null, endedAt: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, costYuan: 0, error: null, progress: null,
    }
    this.insert(RUN, run)
    return run
  }

  updateRun(id: Id, patch: Partial<Run>): void { this.patch(RUN, id, patch, RUN.props.filter(p => p !== 'id')) }

  getRun(id: Id): Run | null { return this.get(RUN, id) ?? null }

  /** Runs dated `sinceDate` or later, newest first (the run log reads top-down). */
  listRuns(sinceDate: string): Run[] { return this.select(RUN, 'WHERE date >= ? ORDER BY rowid DESC', sinceDate) }

  runsOfDate(date: string, kind?: RunKind): Run[] {
    return kind === undefined ? this.select(RUN, 'WHERE date = ? ORDER BY rowid', date) : this.select(RUN, 'WHERE date = ? AND kind = ? ORDER BY rowid', date, kind)
  }

  /** What the runs dated `date` cost in yuan, all of them or those of one product. */
  spentOn(date: string, productId?: Id): number {
    const row = productId === undefined
      ? this.db.prepare('SELECT SUM(cost_yuan) AS total FROM runs WHERE date = ?').get(date)
      : this.db.prepare('SELECT SUM(cost_yuan) AS total FROM runs WHERE date = ? AND product_id = ?').get(date, productId)
    return Math.round(Number(row?.total ?? 0) * 1e6) / 1e6 // sums of binary fractions leave crumbs like 0.30000000000000004
  }

  // ---- settings ----

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings_kv WHERE key = ?').get(key)
    return row ? JSON.parse(String(row.value)) as T : undefined
  }

  /** Stores any JSON-able value under `key`; `undefined` removes the key. */
  setSetting(key: string, value: unknown): void {
    if (value === undefined) this.db.prepare('DELETE FROM settings_kv WHERE key = ?').run(key)
    else this.db.prepare('INSERT INTO settings_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
  }

  // ---- plumbing ----

  private stamp(): string { return this.now().toISOString() }

  private insert<T extends object>(codec: Codec<T>, value: T, extra: Record<string, SQLInputValue> = {}, verb = 'INSERT'): void {
    const columns = [...codec.columns(), ...Object.keys(extra)]
    const values = [...codec.props.map(p => codec.encode(p, (value as Record<string, unknown>)[p])), ...Object.values(extra)]
    this.db.prepare(`${verb} INTO ${codec.table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values)
  }

  /** `tail` is everything after `FROM <table>`: joins, WHERE, ORDER BY. Only this table's columns are read back. */
  private select<T extends object>(codec: Codec<T>, tail: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(`SELECT ${codec.table}.* FROM ${codec.table} ${tail}`).all(...params).map(row => codec.decode(row))
  }

  private get<T extends { id: Id }>(codec: Codec<T>, id: Id): T | undefined { return this.select(codec, 'WHERE id = ?', id)[0] }

  private require<T extends { id: Id }>(codec: Codec<T>, id: Id): T {
    const found = this.get(codec, id)
    if (!found) throw new Error(`${codec.table}: unknown id ${id}`)
    return found
  }

  /** Sets the fields of `patch` (skipping undefined) on the row `id`; only fields in `allowed` may be named. */
  private patch<T extends { id: Id }>(codec: Codec<T>, id: Id, patch: Partial<NoInfer<T>>, allowed: readonly string[]): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined)
    for (const [key] of entries) if (!allowed.includes(key)) throw new Error(`${codec.table}: cannot update ${key}`)
    if (!entries.length) { this.require(codec, id); return }
    const sets = entries.map(([key]) => `${snake(key)} = ?`).join(', ')
    const { changes } = this.db.prepare(`UPDATE ${codec.table} SET ${sets} WHERE id = ?`).run(...entries.map(([key, v]) => codec.encode(key, v)), id)
    if (!changes) throw new Error(`${codec.table}: unknown id ${id}`)
  }
}
