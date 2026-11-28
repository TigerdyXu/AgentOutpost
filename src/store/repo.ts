import { randomUUID } from 'node:crypto'
import type { SQLInputValue, SQLOutputValue } from 'node:sqlite'
import { localDate } from '../core/calendar.ts'
import { FOLLOWED, identityKey, nameKey } from '../core/identity.ts'
import type {
  Brief, Candidate, CardEdit, CardVersion, Dimension, DimensionKey, Facts, Finding, Id, Landscape, Note, NoteKind, Product, ProductStatus, Recap, Run, RunKind, Source, Topic, TopicVersion, Track,
} from '../core/types.ts'
import type { Db } from './db.ts'

type Row = Record<string, SQLOutputValue>
/** How a field is kept in its column: as is, as JSON text, or as 0/1. */
type Kind = 'plain' | 'json' | 'bool'
/** Every field of `T`, so that adding one to a domain type without storing it fails to compile. */
type Shape<T> = { readonly [K in keyof T]-?: Kind }

const DAY_MS = 24 * 60 * 60 * 1000
const snake = (name: string) => name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)

/** Orders the products Outpost follows before the rest; `sort` is stable, so each group stays oldest first. */
const followedFirst = (a: Product, b: Product) => Number(FOLLOWED.includes(b.status)) - Number(FOLLOWED.includes(a.status))

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
const SOURCE = new Codec<Source>('sources', { id: 'plain', url: 'plain', title: 'plain', publisher: 'plain', publishedAt: 'plain', kind: 'plain', isOfficial: 'bool', quote: 'plain', syndicationGroup: 'plain', openedVia: 'plain', quoteFound: 'bool', supportsClaim: 'bool', officialConfirmed: 'bool' })
const FINDING = new Codec<Finding>('findings', { id: 'plain', productId: 'plain', runId: 'plain', headline: 'plain', why: 'plain', importance: 'plain', claimKind: 'plain', sourceIds: 'json', status: 'plain', statusNote: 'plain', unconfirmedUntil: 'plain', dimensions: 'json', inference: 'bool', read: 'bool', late: 'bool', dedupeKey: 'plain', createdAt: 'plain', verifiedOn: 'plain' })
const CARD_VERSION = new Codec<CardVersion>('card_versions', { productId: 'plain', dimension: 'plain', version: 'plain', summary: 'plain', bullets: 'json', body: 'plain', sourceIds: 'json', inferenceSpans: 'json', addedSpans: 'json', changeNote: 'plain', findingIds: 'json', createdAt: 'plain' })
const CARD_EDIT = new Codec<CardEdit>('card_edits', { id: 'plain', productId: 'plain', dimension: 'plain', summary: 'plain', bullets: 'json', body: 'plain', sourceIds: 'json', inferenceSpans: 'json', changeNote: 'plain', findingIds: 'json', status: 'plain' })
const FACTS = new Codec<Facts>('facts', { productId: 'plain', version: 'plain', form: 'plain', platforms: 'plain', price: 'plain', firstReleased: 'plain', rivals: 'json', createdAt: 'plain' })
const BRIEF = new Codec<Brief>('briefs', { date: 'plain', gist: 'plain', findingIds: 'json', minorIds: 'json', quietProductIds: 'json', skipped: 'json', costYuan: 'plain', createdAt: 'plain', updatedAt: 'plain' })
const LANDSCAPE = new Codec<Landscape>('landscapes', { id: 'plain', trackId: 'plain', date: 'plain', gist: 'plain', axes: 'json', positions: 'json', runId: 'plain', createdAt: 'plain' })
const TOPIC = new Codec<Topic>('topics', { id: 'plain', trackId: 'plain', question: 'plain', productIds: 'json', cadence: 'plain', createdAt: 'plain' })
const TOPIC_VERSION = new Codec<TopicVersion>('topic_versions', { id: 'plain', topicId: 'plain', version: 'plain', status: 'plain', cards: 'json', changeNote: 'plain', runId: 'plain', createdAt: 'plain' })
const RECAP = new Codec<Recap>('recaps', { trackId: 'plain', week: 'plain', gist: 'plain', runId: 'plain', createdAt: 'plain' })
const NOTE = new Codec<Note>('notes', { kind: 'plain', subjectId: 'plain', text: 'plain', updatedAt: 'plain' })
const RUN = new Codec<Run>('runs', { id: 'plain', kind: 'plain', date: 'plain', trackId: 'plain', productId: 'plain', sessionId: 'plain', status: 'plain', startedAt: 'plain', endedAt: 'plain', usage: 'json', costYuan: 'plain', error: 'plain', progress: 'json', subject: 'plain' })

type SourcePatch = Partial<Pick<Source, 'openedVia' | 'quoteFound' | 'supportsClaim' | 'syndicationGroup' | 'officialConfirmed'>>
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

  /** The tracks in the user's order (M2.4: as dragged; those never placed after, in the order they were made). */
  listTracks(): Track[] { return this.select(TRACK, 'ORDER BY position IS NULL, position, rowid') }

  /** Puts the tracks named in that order, first; the others follow as they were. Unknown ids are skipped. */
  orderTracks(trackIds: Id[]): void {
    this.db.atomic(() => {
      const named = new Set(trackIds)
      const order = [...trackIds.filter(id => this.get(TRACK, id)), ...this.listTracks().map(t => t.id).filter(id => !named.has(id))]
      const set = this.db.prepare('UPDATE tracks SET position = ? WHERE id = ?')
      order.forEach((id, i) => { set.run(i, id) })
    })
  }

  /** Puts the track's products named in that order, first; the others follow as they were. Ids not in the track are skipped. */
  orderProducts(trackId: Id, productIds: Id[]): void {
    this.db.atomic(() => {
      const inTrack = this.productsOfTrack(trackId).map(p => p.id)
      const named = new Set(productIds)
      const order = [...productIds.filter(id => inTrack.includes(id)), ...inTrack.filter(id => !named.has(id))]
      const set = this.db.prepare('UPDATE track_products SET position = ? WHERE track_id = ? AND product_id = ?')
      order.forEach((id, i) => { set.run(i, trackId, id) })
    })
  }

  /** The products linked to the track, in the user's order (M2.4: as dragged; else the order they were linked), whatever their status. */
  productsOfTrack(trackId: Id): Product[] {
    return this.select(PRODUCT, 'JOIN track_products tp ON tp.product_id = products.id WHERE tp.track_id = ? ORDER BY tp.position IS NULL, tp.position, tp.rowid', trackId)
  }

  /**
   * The dimensions of every track the product belongs to, merged by key; the first label seen for a key wins. An archived
   * track keeps nothing running, so its own dimensions drive no top-up, check or product page.
   */
  dimensionsOfProduct(productId: Id): Dimension[] {
    const rows = this.db.prepare("SELECT t.dimensions FROM track_products tp JOIN tracks t ON t.id = tp.track_id WHERE tp.product_id = ? AND t.status <> 'archived' ORDER BY tp.rowid").all(productId)
    const merged = new Map<string, Dimension>()
    for (const row of rows) for (const d of JSON.parse(String(row.dimensions)) as Dimension[]) if (!merged.has(d.key)) merged.set(d.key, d)
    return [...merged.values()]
  }

  // ---- products and candidates ----

  /**
   * Adds a product, or refreshes the one that is already there: the row `p.id` points at, the same name at the same
   * company (ignoring case and surrounding spaces), or else a row that reads the same by `identityKey` (「千问Go!」 for
   * 「千问Go」; the one Outpost follows if several do, else the oldest). A refresh keeps `id`, `createdAt` and `status`
   * (status moves only through `setProductStatus`, so meeting a tracked product again in another track never demotes
   * it), updates `region` and `form`, merges `officialDomains`, and does not let a null `iconPath` or `dailyBudgetYuan`
   * erase a value it has. The first spelling of name and company stays unless the row was found by `id`, which may
   * rename it.
   */
  upsertProduct(p: Omit<Product, 'id' | 'createdAt'> & { id?: Id }): Product {
    return this.db.atomic(() => {
      const name = p.name.trim()
      const company = p.company.trim()
      const byId = p.id === undefined ? undefined : this.get(PRODUCT, p.id)
      const existing = byId
        ?? this.select(PRODUCT, 'WHERE name = ? COLLATE NOCASE AND company = ? COLLATE NOCASE', name, company)[0]
        ?? this.readingAlike(name, company).sort(followedFirst)[0]
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

  /**
   * The product `product` is another row of: one with the same `identityKey` (the name and company spelled a little
   * differently) that Outpost follows (tracking, paused or in 建档中), the oldest if several do; null when there is none.
   * Never `product` itself, and never an archived or candidate row.
   */
  findSameProduct(product: Product): Product | null {
    return this.readingAlike(product.name, product.company).find(p => p.id !== product.id && FOLLOWED.includes(p.status)) ?? null
  }

  /**
   * The products Outpost follows (tracking, paused or in 建档中) whose name reads as `name` (`nameKey`: width, case, spaces
   * and punctuation aside), whatever their company, oldest first: what a product added by name may already be.
   */
  findFollowedByName(name: string): Product[] {
    const key = nameKey(name)
    return this.select(PRODUCT, 'ORDER BY created_at, rowid').filter(p => FOLLOWED.includes(p.status) && nameKey(p.name) === key)
  }

  getProduct(id: Id): Product | null { return this.get(PRODUCT, id) ?? null }

  setProductStatus(id: Id, status: ProductStatus): void { this.patch(PRODUCT, id, { status }, ['status']) }

  /** Sets the product's own daily budget in yuan (null: none, only the total applies); nothing else changes. */
  setProductBudget(id: Id, dailyBudgetYuan: number | null): void {
    const { changes } = this.db.prepare('UPDATE products SET daily_budget_yuan = ? WHERE id = ?').run(dailyBudgetYuan, id)
    if (!changes) throw new Error(`products: unknown id ${id}`)
  }

  /** Sets where the product's icon file is kept (null clears it); nothing else about the product changes. */
  setProductIcon(id: Id, iconPath: string | null): void { this.patch(PRODUCT, id, { iconPath }, ['iconPath']) }

  /** Sets the product's official domains (as given: the caller normalises them); nothing else changes. */
  setOfficialDomains(id: Id, officialDomains: string[]): void { this.patch(PRODUCT, id, { officialDomains }, ['officialDomains']) }

  /**
   * Renames the product (name and company, trimmed). Another row that has exactly that name at that company (case aside),
   * which the unique index would refuse, is merged into this one: its candidates name this product from now on, and the
   * row is deleted (`deleteProduct`). The caller makes sure that row is not one Outpost follows (that is a clash to refuse,
   * not a merge); the rows merged away are returned, so that their icon files can go too.
   * @throws When the product does not exist.
   */
  renameProduct(id: Id, name: string, company: string): Product[] {
    return this.db.atomic(() => {
      this.require(PRODUCT, id)
      const merged = this.select(PRODUCT, 'WHERE name = ? COLLATE NOCASE AND company = ? COLLATE NOCASE AND id <> ?', name.trim(), company.trim(), id)
      for (const other of merged) {
        this.db.prepare('UPDATE candidates SET product_id = ? WHERE product_id = ?').run(id, other.id)
        this.deleteProduct(other.id)
      }
      this.patch(PRODUCT, id, { name: name.trim(), company: company.trim() }, ['name', 'company'])
      return merged
    })
  }

  /**
   * Erases the product and everything Outpost learnt about it: its cards and their history, its facts, its card edits,
   * its findings and the sources only they and its cards cite, its place in every track, the candidates that name it, and
   * its entries in every brief (its findings, main and minor; its quiet and skipped lines). A brief's gist, which the AI
   * wrote, is left as it is. Its runs stay (what was spent stays spent), each keeping the product's name in `subject` so the
   * run log can still say whose it was. Returns the product as it was.
   * @throws When the product does not exist.
   */
  deleteProduct(id: Id): Product {
    return this.db.atomic(() => {
      const product = this.require(PRODUCT, id)
      const column = (sql: string) => this.db.prepare(sql).all(id).map(row => String(Object.values(row)[0]))
      const findingIds = new Set(column('SELECT id FROM findings WHERE product_id = ?'))
      const cited = new Set([
        ...column('SELECT j.value FROM findings, json_each(findings.source_ids) j WHERE findings.product_id = ?'),
        ...column('SELECT j.value FROM card_versions, json_each(card_versions.source_ids) j WHERE card_versions.product_id = ?'),
        ...column('SELECT j.value FROM card_edits, json_each(card_edits.source_ids) j WHERE card_edits.product_id = ?'),
      ])
      for (const table of ['findings', 'card_versions', 'card_edits', 'facts', 'candidates', 'track_products'])
        this.db.prepare(`DELETE FROM ${table} WHERE product_id = ?`).run(id)
      // A source some other row still cites stays (none should, but a shared one must not vanish from under it).
      this.pruneSources(cited)
      // Its topics go on without it (M2.3); one about it alone goes.
      for (const topic of this.topicsOfProduct(id)) {
        const left = topic.productIds.filter(p => p !== id)
        if (left.length) this.updateTopic(topic.id, { productIds: left })
        else this.deleteTopic(topic.id)
      }
      for (const brief of this.select(BRIEF, 'ORDER BY date')) {
        const kept: Brief = {
          ...brief,
          findingIds: brief.findingIds.filter(f => !findingIds.has(f)),
          minorIds: brief.minorIds.filter(f => !findingIds.has(f)),
          quietProductIds: brief.quietProductIds.filter(p => p !== id),
          skipped: brief.skipped.filter(s => s.productId !== id),
        }
        if (JSON.stringify(kept) !== JSON.stringify(brief)) this.putBrief(kept)
      }
      this.db.prepare('UPDATE runs SET subject = ? WHERE product_id = ?').run(product.name, id)
      // The user's notes on it and on its findings go with them (M3.3).
      this.db.prepare("DELETE FROM notes WHERE kind = 'product' AND subject_id = ?").run(id)
      const deleteNote = this.db.prepare("DELETE FROM notes WHERE kind = 'finding' AND subject_id = ?")
      for (const findingId of findingIds) deleteNote.run(findingId)
      this.db.prepare('DELETE FROM products WHERE id = ?').run(id)
      return product
    })
  }

  /**
   * Erases the track: its place for every product, its candidates, its maps (M2.1), and what was remembered of it
   * (`settings` keys the caller names). The products only this track has (no other track lists them) are erased with it (`deleteProduct`), and
   * so are the rows of products it recommended that nobody follows and nothing else names (no other track's candidate,
   * no track). Its recommendations' and maps' runs stay, keeping the track's name in `subject`. Returns the products erased, the
   * followed ones and those recommended rows alike.
   * @throws When the track does not exist.
   */
  deleteTrack(trackId: Id, settingKeys: string[] = []): Product[] {
    return this.db.atomic(() => {
      const track = this.require(TRACK, trackId)
      const inOthers = (productId: Id) => this.db.prepare('SELECT 1 FROM track_products WHERE product_id = ? AND track_id <> ?').get(productId, trackId) !== undefined
      const own = this.productsOfTrack(trackId).filter(p => !inOthers(p.id))
      const recommended = [...new Set(this.listCandidates(trackId).map(c => c.productId))]
      for (const p of own) this.deleteProduct(p.id)
      this.db.prepare('DELETE FROM candidates WHERE track_id = ?').run(trackId)
      this.db.prepare('DELETE FROM track_products WHERE track_id = ?').run(trackId)
      const orphans = recommended.flatMap(id => {
        const p = this.get(PRODUCT, id)
        if (!p || FOLLOWED.includes(p.status)) return []
        const named = this.db.prepare('SELECT 1 FROM candidates WHERE product_id = ? UNION SELECT 1 FROM track_products WHERE product_id = ?').get(id, id)
        return named ? [] : [this.deleteProduct(id)]
      })
      for (const key of settingKeys) this.setSetting(key, undefined)
      this.db.prepare("UPDATE runs SET subject = ? WHERE track_id = ? AND kind IN ('recommend', 'landscape', 'recap')").run(track.name, trackId)
      this.db.prepare('DELETE FROM landscapes WHERE track_id = ?').run(trackId)
      this.db.prepare('DELETE FROM recaps WHERE track_id = ?').run(trackId)
      for (const topic of this.topicsOfTrack(trackId)) this.deleteTopic(topic.id)
      this.db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)
      return [...own, ...orphans]
    })
  }

  /** Puts the product in the track's tracked list; linking twice is harmless. */
  linkProduct(trackId: Id, productId: Id): void {
    this.db.prepare('INSERT OR IGNORE INTO track_products (track_id, product_id) VALUES (?, ?)').run(trackId, productId)
  }

  /**
   * Takes the product out of the track's tracked list, and nothing else: the product, its cards and its history stay (the
   * cards of a dimension only that track had are kept, they just no longer show). Not linked: nothing happens.
   */
  unlinkProduct(trackId: Id, productId: Id): void {
    this.db.prepare('DELETE FROM track_products WHERE track_id = ? AND product_id = ?').run(trackId, productId)
  }

  /** Runs `fn` as one: all of its writes, or none if it throws (`Db.atomic`). `fn` must be synchronous. */
  atomic<T>(fn: () => T): T { return this.db.atomic(fn) }

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

  /** Records whether the user picked the candidate (it starts as the agent's pre-selection: strong ones picked). */
  setCandidateSelected(id: Id, selected: boolean): void {
    const { changes } = this.db.prepare('UPDATE candidates SET selected = ? WHERE id = ?').run(selected ? 1 : 0, id)
    if (!changes) throw new Error(`candidates: unknown id ${id}`)
  }

  /**
   * The batch of recommendations whose candidate was added last, or null when the track has none. The candidate a run of
   * another kind handed in (a product confirmed by name, `identify`) is no batch to pick from; a batch id that names no
   * run at all counts.
   */
  latestBatchId(trackId: Id): Id | null {
    const row = this.db.prepare(`SELECT batch_id FROM candidates WHERE track_id = ?
      AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = candidates.batch_id AND runs.kind <> 'recommend') ORDER BY rowid DESC LIMIT 1`).get(trackId)
    return row ? String(row.batch_id) : null
  }

  // ---- sources and findings ----

  addSource(s: Omit<Source, 'id'>): Source {
    const source: Source = { ...s, id: randomUUID() }
    this.insert(SOURCE, source)
    return source
  }

  updateSource(id: Id, patch: SourcePatch): void { this.patch(SOURCE, id, patch, ['openedVia', 'quoteFound', 'supportsClaim', 'syndicationGroup', 'officialConfirmed']) }

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

  /** Every dimension key some product has a card version or a card edit for, whatever the product or track. */
  cardDimensions(): Set<DimensionKey> {
    const rows = this.db.prepare('SELECT dimension FROM card_versions UNION SELECT dimension FROM card_edits').all()
    return new Set(rows.map(row => String(row.dimension)))
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

  /** The latest date before `date` that has a brief, or null. */
  previousBriefDate(date: string): string | null {
    const row = this.db.prepare('SELECT date FROM briefs WHERE date < ? ORDER BY date DESC LIMIT 1').get(date)
    return row ? String(row.date) : null
  }

  /** Saves the brief as given, replacing any earlier one for its date. */
  putBrief(b: Brief): void { this.insert(BRIEF, b, {}, 'INSERT OR REPLACE') }

  // ---- maps (M2.1) ----

  /**
   * Keeps a drawing of the track's map; earlier ones stay. `createdAt` (default now) is the time of the dossiers it was
   * drawn from: a card written after it is news to the next drawing.
   */
  addLandscape(l: Omit<Landscape, 'id' | 'createdAt'> & { createdAt?: string }): Landscape {
    const landscape: Landscape = { ...l, id: randomUUID(), createdAt: l.createdAt ?? this.stamp() }
    this.insert(LANDSCAPE, landscape)
    return landscape
  }

  /** The track's drawings, oldest first. */
  landscapesOfTrack(trackId: Id): Landscape[] { return this.select(LANDSCAPE, 'WHERE track_id = ? ORDER BY created_at, rowid', trackId) }

  // ---- 专题 (M2.3) ----

  createTopic(t: Omit<Topic, 'id' | 'createdAt'>): Topic {
    const topic: Topic = { ...t, id: randomUUID(), createdAt: this.stamp() }
    this.insert(TOPIC, topic)
    return topic
  }

  getTopic(id: Id): Topic | null { return this.get(TOPIC, id) ?? null }

  /** The track's topics, oldest first. */
  topicsOfTrack(trackId: Id): Topic[] { return this.select(TOPIC, 'WHERE track_id = ? ORDER BY created_at, rowid', trackId) }

  /** The topics about the product, oldest first. */
  topicsOfProduct(productId: Id): Topic[] {
    return this.select(TOPIC, 'WHERE EXISTS (SELECT 1 FROM json_each(topics.product_ids) j WHERE j.value = ?) ORDER BY created_at, rowid', productId)
  }

  updateTopic(id: Id, patch: Partial<Pick<Topic, 'cadence' | 'productIds'>>): Topic {
    this.patch(TOPIC, id, patch, ['cadence', 'productIds'])
    return this.require(TOPIC, id)
  }

  /**
   * A new round of the topic, as a draft with no cards yet. Drafts an earlier round left (cut short by a quit, say) are
   * rejected: only the newest round is ever checked.
   */
  addTopicDraft(topicId: Id, runId: Id | null = null): TopicVersion {
    return this.db.atomic(() => {
      this.db.prepare("UPDATE topic_versions SET status = 'rejected' WHERE topic_id = ? AND status = 'draft'").run(topicId)
      const draft: TopicVersion = { id: randomUUID(), topicId, version: null, status: 'draft', cards: [], changeNote: '', runId, createdAt: this.stamp() }
      this.insert(TOPIC_VERSION, draft)
      return draft
    })
  }

  getTopicVersion(id: Id): TopicVersion | null { return this.get(TOPIC_VERSION, id) ?? null }

  /** Rejects, with `why`, every round still a draft: on start, those an Outpost that did not stop cleanly left behind. */
  rejectTopicDrafts(why: string): void {
    this.db.prepare("UPDATE topic_versions SET status = 'rejected', change_note = ? WHERE status = 'draft'").run(why)
  }

  updateTopicVersion(id: Id, patch: Partial<Pick<TopicVersion, 'version' | 'status' | 'cards' | 'changeNote' | 'runId'>>): TopicVersion {
    this.patch(TOPIC_VERSION, id, patch, ['version', 'status', 'cards', 'changeNote', 'runId'])
    return this.require(TOPIC_VERSION, id)
  }

  /** Every round of the topic, oldest first: drafts, finals and rejected ones. */
  topicVersions(topicId: Id): TopicVersion[] { return this.select(TOPIC_VERSION, 'WHERE topic_id = ? ORDER BY created_at, rowid', topicId) }

  /** The topic's newest final version, or null. */
  latestTopicVersion(topicId: Id): TopicVersion | null {
    return this.select(TOPIC_VERSION, "WHERE topic_id = ? AND status = 'final' ORDER BY version DESC LIMIT 1", topicId)[0] ?? null
  }

  /** Erases the topic, its rounds, and the sources only they cite. */
  deleteTopic(id: Id): void {
    this.db.atomic(() => {
      const cited = new Set(this.topicVersions(id).flatMap(v => v.cards.flatMap(c => c.sourceIds)))
      this.db.prepare('DELETE FROM topic_versions WHERE topic_id = ?').run(id)
      this.db.prepare('DELETE FROM topics WHERE id = ?').run(id)
      this.pruneSources(cited)
    })
  }

  /** Deletes the sources among `ids` that no finding, card, card edit or topic round cites any more. */
  pruneSources(ids: Iterable<Id>): void {
    const stillCited = new Set(this.db.prepare(`SELECT j.value FROM findings, json_each(findings.source_ids) j
      UNION SELECT j.value FROM card_versions, json_each(card_versions.source_ids) j
      UNION SELECT j.value FROM card_edits, json_each(card_edits.source_ids) j
      UNION SELECT s.value FROM topic_versions, json_each(topic_versions.cards) c, json_each(c.value, '$.sourceIds') s`).all().map(row => String(row.value)))
    const remove = this.db.prepare('DELETE FROM sources WHERE id = ?')
    for (const sourceId of ids) if (!stillCited.has(sourceId)) remove.run(sourceId)
  }

  /** The track's newest drawing, or null. */
  latestLandscape(trackId: Id): Landscape | null { return this.select(LANDSCAPE, 'WHERE track_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', trackId)[0] ?? null }

  createRun(r: Pick<Run, 'kind' | 'date' | 'trackId' | 'productId'> & Partial<Pick<Run, 'subject'>>): Run {
    const run: Run = {
      ...r, id: randomUUID(), sessionId: null, status: 'queued', startedAt: null, endedAt: null,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, costYuan: 0, error: null, progress: null, subject: r.subject ?? null,
    }
    this.insert(RUN, run)
    return run
  }

  updateRun(id: Id, patch: Partial<Run>): void { this.patch(RUN, id, patch, RUN.props.filter(p => p !== 'id')) }

  getRun(id: Id): Run | null { return this.get(RUN, id) ?? null }

  /** The run whose session is `sessionId` (the latest, should there be more than one), or null. */
  runOfSession(sessionId: string): Run | null {
    return this.select(RUN, 'WHERE session_id = ? ORDER BY rowid DESC LIMIT 1', sessionId)[0] ?? null
  }

  /** Runs dated `sinceDate` or later, newest first (the run log reads top-down). */
  listRuns(sinceDate: string): Run[] { return this.select(RUN, 'WHERE date >= ? ORDER BY rowid DESC', sinceDate) }

  /** The track's runs of that kind, newest first. */
  runsOfTrack(trackId: Id, kind: RunKind): Run[] { return this.select(RUN, 'WHERE track_id = ? AND kind = ? ORDER BY rowid DESC', trackId, kind) }

  /** The run of that kind created last for the track or product given (both, if both are), or null. */
  latestRun(kind: RunKind, about: { trackId?: Id; productId?: Id }): Run | null {
    const where = ['kind = ?']
    const params: SQLInputValue[] = [kind]
    if (about.trackId !== undefined) { where.push('track_id = ?'); params.push(about.trackId) }
    if (about.productId !== undefined) { where.push('product_id = ?'); params.push(about.productId) }
    return this.select(RUN, `WHERE ${where.join(' AND ')} ORDER BY rowid DESC LIMIT 1`, ...params)[0] ?? null
  }

  /** The runs still `queued` or `running`, newest first: all of them, or those of one product. */
  activeRuns(productId?: Id): Run[] {
    return productId === undefined
      ? this.select(RUN, "WHERE status IN ('queued', 'running') ORDER BY rowid DESC")
      : this.select(RUN, "WHERE status IN ('queued', 'running') AND product_id = ? ORDER BY rowid DESC", productId)
  }

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

  // ---- weekly recaps (M3.4) ----

  /** The AI's summary of the track's week (`week`: its Monday), or null. */
  getRecap(trackId: Id, week: string): Recap | null {
    return this.select(RECAP, 'WHERE track_id = ? AND week = ?', trackId, week)[0] ?? null
  }

  /** Keeps the summary of the track's week, stamped now (a later one for the same week replaces it). */
  putRecap(r: Omit<Recap, 'createdAt'>): Recap {
    const recap: Recap = { ...r, createdAt: this.stamp() }
    this.db.prepare('INSERT INTO recaps (track_id, week, gist, run_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(track_id, week) DO UPDATE SET gist = excluded.gist, run_id = excluded.run_id, created_at = excluded.created_at')
      .run(recap.trackId, recap.week, recap.gist, recap.runId, recap.createdAt)
    return recap
  }

  /** Every summary kept, newest first. */
  listRecaps(): Recap[] { return this.select(RECAP, 'ORDER BY created_at DESC, rowid DESC') }

  /** The topic's versions written in [`from`, `to`), oldest first. */
  topicVersionsBetween(topicId: Id, from: string, to: string): TopicVersion[] {
    return this.select(TOPIC_VERSION, 'WHERE topic_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at, rowid', topicId, from, to)
  }

  /** The summary of the track's latest week that has one, or null. */
  latestRecap(trackId: Id): Recap | null { return this.select(RECAP, 'WHERE track_id = ? ORDER BY week DESC LIMIT 1', trackId)[0] ?? null }

  /** The product's findings made in [`from`, `to`) (ISO times), oldest first: a week's, read without the rest (M3.4). */
  findingsBetween(productId: Id, from: string, to: string): Finding[] {
    return this.select(FINDING, 'WHERE product_id = ? AND created_at >= ? AND created_at < ? ORDER BY rowid', productId, from, to)
  }

  /** The product's card versions written in [`from`, `to`), oldest first. */
  cardVersionsBetween(productId: Id, from: string, to: string): CardVersion[] {
    return this.select(CARD_VERSION, 'WHERE product_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at, rowid', productId, from, to)
  }

  /** When the product's first card was written, or null: when its dossier was first built. */
  firstCardAt(productId: Id): string | null {
    const row = this.db.prepare('SELECT MIN(created_at) AS at FROM card_versions WHERE product_id = ?').get(productId)
    return row?.at == null ? null : String(row.at)
  }

  // ---- the user's notes (M3.3) ----

  /** The user's note on the thing, or null. */
  getNote(kind: NoteKind, subjectId: Id): Note | null {
    return this.select(NOTE, 'WHERE kind = ? AND subject_id = ?', kind, subjectId)[0] ?? null
  }

  /** The user's notes on those of `subjectIds` that have one, by subject. */
  notesOf(kind: NoteKind, subjectIds: Iterable<Id>): Map<Id, Note> {
    const ids = [...new Set(subjectIds)]
    if (!ids.length) return new Map()
    const notes = this.select(NOTE, `WHERE kind = ? AND subject_id IN (${ids.map(() => '?').join(',')})`, kind, ...ids)
    return new Map(notes.map(note => [note.subjectId, note]))
  }

  /** Writes the user's note on the thing (stamped now), or erases it when `text` is blank; returns what is kept. */
  setNote(kind: NoteKind, subjectId: Id, text: string): Note | null {
    const kept = text.trim()
    if (!kept) {
      this.db.prepare('DELETE FROM notes WHERE kind = ? AND subject_id = ?').run(kind, subjectId)
      return null
    }
    const note: Note = { kind, subjectId, text: kept, updatedAt: this.stamp() }
    this.db.prepare('INSERT INTO notes (kind, subject_id, text, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, subject_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at')
      .run(kind, subjectId, note.text, note.updatedAt)
    return note
  }

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

  /** Every product whose `identityKey` is that of this name and company, oldest first. */
  private readingAlike(name: string, company: string): Product[] {
    const key = identityKey(name, company)
    return this.select(PRODUCT, 'ORDER BY created_at, rowid').filter(p => identityKey(p.name, p.company) === key)
  }

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
