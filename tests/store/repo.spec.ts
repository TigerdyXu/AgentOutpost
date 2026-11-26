import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { localDate } from '../../src/core/calendar.ts'
import type { Brief, CardVersion, Candidate, Finding, Product, Source, Track } from '../../src/core/types.ts'
import { lockDataDir, openDb, type Db } from '../../src/store/db.ts'
import { MIGRATIONS, migrate } from '../../src/store/migrations.ts'
import { Repo } from '../../src/store/repo.ts'

const TABLES = ['tracks', 'products', 'track_products', 'candidates', 'sources', 'findings', 'card_versions', 'card_edits', 'facts', 'briefs', 'runs', 'settings_kv']
const mode = (path: string) => statSync(path).mode & 0o777

let dir: string
let dbPath: string
let opened: Db[]
let time: Date
const open = (path = dbPath) => { const db = openDb(path); opened.push(db); return db }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outpost-store-'))
  dbPath = join(dir, 'outpost.sqlite')
  opened = []
  time = new Date('2026-11-25T08:00:00.000Z')
})
afterEach(() => {
  for (const db of opened) db.close()
  rmSync(dir, { recursive: true, force: true })
})

const newRepo = () => new Repo(open(), () => time)
const spec = (over: Partial<Omit<Track, 'id' | 'createdAt'>> = {}): Omit<Track, 'id' | 'createdAt'> =>
  ({ name: 'AI 编程助手', brief: '盯住编程类 Agent', dimensions: [{ key: 'positioning', label: '定位' }, { key: 'pricing', label: '价格' }], status: 'active', ...over })
const product = (over: Partial<Omit<Product, 'id' | 'createdAt'>> = {}): Omit<Product, 'id' | 'createdAt'> =>
  ({ name: 'Cursor', company: 'Anysphere', region: 'overseas', form: 'IDE', iconPath: null, officialDomains: ['cursor.com'], status: 'tracking', dailyBudgetYuan: null, ...over })
/**
 * A repo whose database also takes rows written straight into the table, one minute apart: the spellings that sit side by
 * side in a database made before alike spellings were told to be one product (`upsertProduct` no longer makes them).
 */
const twinsRepo = () => {
  const db = open()
  const repo = new Repo(db, () => time)
  let made = 0
  const insertAlike = (id: string, name: string, company: string, status: Product['status']) => {
    const createdAt = new Date(time.getTime() + made++ * 60_000).toISOString()
    db.prepare('INSERT INTO products (id, name, company, region, form, icon_path, official_domains, status, daily_budget_yuan, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)')
      .run(id, name, company, 'domestic', 'App', '[]', status, createdAt)
  }
  return { repo, db, insertAlike }
}
const sourceSpec = (over: Partial<Omit<Source, 'id'>> = {}): Omit<Source, 'id'> =>
  ({ url: 'https://cursor.com/changelog', title: 'Changelog', publisher: 'Cursor', publishedAt: '2026-11-24', kind: 'official', isOfficial: true, quote: '推出新定价', syndicationGroup: null, openedVia: null, quoteFound: null, supportsClaim: null, ...over })
const findingSpec = (over: Partial<Omit<Finding, 'id' | 'createdAt'>> = {}): Omit<Finding, 'id' | 'createdAt'> =>
  ({ productId: 'p1', runId: 'r1', headline: 'Cursor 推出新定价', why: '价格变了', importance: 'major', claimKind: 'self', sourceIds: ['s1'], status: 'pending', statusNote: null, unconfirmedUntil: null, dimensions: ['pricing'], inference: false, read: false, late: false, dedupeKey: 'cursor-pricing', verifiedOn: null, ...over })
const cardAt = (version: number, over: Partial<CardVersion> = {}): CardVersion =>
  ({ productId: 'p1', dimension: 'pricing', version, summary: `第 ${version} 版`, bullets: ['要点'], body: `正文 ${version}[1]`, sourceIds: ['s1'], inferenceSpans: [], addedSpans: [], changeNote: '改了', findingIds: ['f1'], createdAt: `2026-11-2${version}T00:00:00.000Z`, ...over })

describe('openDb', () => {
  it('creates the data directory 700, the file 600, a WAL database with full sync and every table', () => {
    const nested = join(dir, 'data', 'deeper', 'outpost.sqlite')
    const db = open(nested)
    expect(mode(join(dir, 'data', 'deeper'))).toBe(0o700)
    expect(mode(nested)).toBe(0o600)
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' })
    expect(db.prepare('PRAGMA synchronous').get()).toMatchObject({ synchronous: 2 }) // 2 = FULL
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: MIGRATIONS.length })
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => String(r.name))
    expect(tables.sort()).toEqual([...TABLES].sort())
  })

  it('tightens a database file that already exists with loose permissions, and keeps the WAL files private', () => {
    writeFileSync(dbPath, '', { mode: 0o644 })
    chmodSync(dbPath, 0o644)
    const db = open()
    expect(mode(dbPath)).toBe(0o600)
    new Repo(db).setSetting('k', 1) // forces the -wal file into existence
    expect(mode(`${dbPath}-wal`)).toBe(0o600)
    expect(mode(`${dbPath}-shm`)).toBe(0o600)
  })

  it('reopens an existing database without error and keeps its data', () => {
    const first = new Repo(open())
    const track = first.createTrack(spec())
    first.setSetting('lastCompletedDailyDate', '2026-11-24')
    opened.pop()!.close()
    const again = new Repo(open())
    const reopened = new Repo(open()) // a second handle at the same time is fine too
    expect(again.listTracks()).toEqual([track])
    expect(reopened.getSetting('lastCompletedDailyDate')).toBe('2026-11-24')
  })

  it('refuses a database written by a newer version and leaves it untouched', () => {
    const raw = new DatabaseSync(dbPath)
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`)
    raw.close()
    expect(() => openDb(dbPath)).toThrow(/newer/)
    const check = new DatabaseSync(dbPath)
    expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: MIGRATIONS.length + 1 })
    expect(check.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()).toMatchObject({ n: 0 })
    check.close()
  })

  it('adds the verified-on column to a database made before it, keeping its findings', () => {
    const raw = new DatabaseSync(dbPath)
    migrate(raw, MIGRATIONS.slice(0, 1)) // the schema as the first build shipped it
    raw.prepare(`INSERT INTO findings (id, product_id, run_id, headline, why, importance, claim_kind, source_ids, status, status_note, unconfirmed_until,
      dimensions, inference, read, late, dedupe_key, created_at, date) VALUES ('f-old', 'p1', 'r1', '旧发现', '旧', 'major', 'self', '["s1"]', 'verified', NULL, NULL,
      '[]', 0, 0, 0, 'k-old', '2026-11-20T08:00:00.000Z', '2026-11-20')`).run()
    raw.close()

    const db = open()

    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: MIGRATIONS.length })
    expect(db.prepare('PRAGMA table_info(findings)').all().map(c => c.name)).toContain('verified_on')
    const repo = new Repo(db, () => time)
    expect(repo.findingsOfProduct('p1')).toMatchObject([{ id: 'f-old', headline: '旧发现', status: 'verified', verifiedOn: null }])
    expect(repo.findingsOfDate('2026-11-20').map(f => f.id)).toEqual(['f-old'])
  })

  it('adds the subject column to the runs of a database made before it, keeping them', () => {
    const raw = new DatabaseSync(dbPath)
    migrate(raw, MIGRATIONS.slice(0, 2)) // the schema as M1.1 shipped it
    raw.prepare(`INSERT INTO runs (id, kind, date, track_id, product_id, session_id, status, started_at, ended_at, usage, cost_yuan, error, progress)
      VALUES ('r-old', 'daily', '2026-11-20', NULL, 'p1', NULL, 'done', NULL, NULL, '{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0}', 0.2, NULL, NULL)`).run()
    raw.close()

    const db = open()

    expect(db.prepare('PRAGMA table_info(runs)').all().map(c => c.name)).toContain('subject')
    const repo = new Repo(db, () => time)
    expect(repo.getRun('r-old')).toMatchObject({ id: 'r-old', kind: 'daily', productId: 'p1', costYuan: 0.2, subject: null })
  })

  it('close is safe to call twice', () => {
    const db = openDb(dbPath)
    db.close()
    expect(() => db.close()).not.toThrow()
  })
})

describe('migrate', () => {
  it('runs only the migrations the database has not seen, in order', () => {
    const raw = new DatabaseSync(':memory:')
    migrate(raw, ['CREATE TABLE a (x)'])
    expect(raw.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
    migrate(raw, ['CREATE TABLE a (x)', 'CREATE TABLE b (y)', 'ALTER TABLE b ADD COLUMN z'])
    expect(raw.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 })
    expect(raw.prepare('PRAGMA table_info(b)').all().map(c => c.name)).toEqual(['y', 'z'])
    migrate(raw, ['CREATE TABLE a (x)', 'CREATE TABLE b (y)', 'ALTER TABLE b ADD COLUMN z']) // already current: nothing to do
    raw.close()
  })

  it('rolls a failing migration back completely and keeps the earlier ones', () => {
    const raw = new DatabaseSync(':memory:')
    expect(() => migrate(raw, ['CREATE TABLE a (x)', 'CREATE TABLE b (y); INSERT INTO nowhere VALUES (1)'])).toThrow(/nowhere/)
    expect(raw.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
    const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name)
    expect(names).toEqual(['a'])
    raw.close()
  })
})

describe('Db.atomic', () => {
  const count = (db: Db) => Number(db.prepare('SELECT count(*) AS n FROM settings_kv').get()!.n)
  const put = (db: Db, key: string) => db.prepare('INSERT INTO settings_kv (key, value) VALUES (?, ?)').run(key, '1')

  it('returns the value and commits when the callback succeeds', () => {
    const db = open()
    expect(db.atomic(() => { put(db, 'a'); return 42 })).toBe(42)
    expect(count(db)).toBe(1)
  })

  it('rolls everything back when the callback throws, and rethrows the same error', () => {
    const repo = newRepo()
    const db = opened[0]!
    const boom = new Error('boom')
    expect(() => db.atomic(() => {
      repo.createTrack(spec())
      repo.setSetting('x', 1)
      throw boom
    })).toThrow(boom)
    expect(repo.listTracks()).toEqual([])
    expect(repo.getSetting('x')).toBeUndefined()
    expect(count(db)).toBe(0)
  })

  it('nests: an inner failure the outer catches loses only the inner work', () => {
    const db = open()
    db.atomic(() => {
      put(db, 'outer')
      expect(() => db.atomic(() => { put(db, 'inner'); throw new Error('inner') })).toThrow('inner')
      put(db, 'outer2')
    })
    expect(db.prepare('SELECT key FROM settings_kv ORDER BY key').all().map(r => r.key)).toEqual(['outer', 'outer2'])
  })

  it('nests: an outer failure also undoes an inner block that had succeeded', () => {
    const db = open()
    expect(() => db.atomic(() => {
      db.atomic(() => put(db, 'inner'))
      throw new Error('outer')
    })).toThrow('outer')
    expect(count(db)).toBe(0)
    db.atomic(() => put(db, 'after')) // the savepoint names are free again afterwards
    expect(count(db)).toBe(1)
  })

  it('refuses an async callback instead of committing before it finishes', () => {
    const db = open()
    expect(() => db.atomic((async () => { put(db, 'a') }) as unknown as () => void)).toThrow(/synchronous/)
    expect(count(db)).toBe(0)
  })
})

describe('lockDataDir', () => {
  it('creates the directory 700, refuses a second holder, and can be taken again after release', () => {
    const data = join(dir, 'data')
    const release = lockDataDir(data)
    expect(mode(data)).toBe(0o700)
    expect(() => lockDataDir(data)).toThrow(/already being held|ELOCKED/)
    release()
    const again = lockDataDir(data)
    again()
  })

  it('keeps its lock file inside the data directory, not beside it', () => {
    const data = join(dir, 'data')
    const release = lockDataDir(data)
    expect(statSync(join(data, 'outpost.lock')).isDirectory()).toBe(true)
    expect(() => statSync(`${data}.lock`)).toThrow()
    release()
  })

  it('works on a directory that already exists', () => {
    const data = join(dir, 'existing')
    mkdirSync(data)
    const release = lockDataDir(data)
    release()
  })
})

describe('Repo: tracks and products', () => {
  it('unions the dimensions of every track a product belongs to, in order of first appearance', () => {
    const repo = newRepo()
    const a = repo.createTrack(spec({ name: 'A', dimensions: [{ key: 'positioning', label: '定位' }, { key: 'pricing', label: '价格' }] }))
    const b = repo.createTrack(spec({ name: 'B', dimensions: [{ key: 'pricing', label: '定价（B 的叫法）' }, { key: 'privacy', label: '隐私' }] }))
    const cursor = repo.upsertProduct(product())
    const other = repo.upsertProduct(product({ name: 'Zed', company: 'Zed Industries' }))
    repo.linkProduct(a.id, cursor.id)
    repo.linkProduct(b.id, cursor.id)
    repo.linkProduct(b.id, other.id)
    expect(repo.dimensionsOfProduct(cursor.id)).toEqual([{ key: 'positioning', label: '定位' }, { key: 'pricing', label: '价格' }, { key: 'privacy', label: '隐私' }])
    expect(repo.dimensionsOfProduct(other.id)).toEqual([{ key: 'pricing', label: '定价（B 的叫法）' }, { key: 'privacy', label: '隐私' }])
    expect(repo.dimensionsOfProduct('nobody')).toEqual([])
    expect(repo.productsOfTrack(b.id).map(p => p.name)).toEqual(['Cursor', 'Zed'])
    expect(repo.productsOfTrack(a.id).map(p => p.name)).toEqual(['Cursor'])
  })

  it('linking the same product to the same track twice keeps one link', () => {
    const repo = newRepo()
    const t = repo.createTrack(spec())
    const p = repo.upsertProduct(product())
    repo.linkProduct(t.id, p.id)
    repo.linkProduct(t.id, p.id)
    expect(repo.productsOfTrack(t.id)).toHaveLength(1)
  })

  it('createTrack fills id and createdAt; updateTrack patches only the named fields and persists them', () => {
    const repo = newRepo()
    const t = repo.createTrack(spec())
    expect(t).toMatchObject({ name: 'AI 编程助手', status: 'active', createdAt: '2026-11-25T08:00:00.000Z' })
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/)
    const updated = repo.updateTrack(t.id, { name: '新名字', status: 'archived', dimensions: [{ key: 'x', label: 'X' }] })
    expect(updated).toEqual({ ...t, name: '新名字', status: 'archived', dimensions: [{ key: 'x', label: 'X' }] })
    expect(repo.listTracks()).toEqual([updated])
    expect(repo.updateTrack(t.id, { brief: '改了关注点' }).name).toBe('新名字')
  })

  it('updateTrack on an unknown id fails, and a patch cannot touch id or createdAt', () => {
    const repo = newRepo()
    expect(() => repo.updateTrack('nope', { name: 'x' })).toThrow(/unknown/)
    const t = repo.createTrack(spec())
    expect(() => repo.updateTrack(t.id, { id: 'other' } as never)).toThrow(/cannot update/)
    expect(() => repo.updateTrack(t.id, { createdAt: 'x' } as never)).toThrow(/cannot update/)
    expect(repo.listTracks()[0]).toEqual(t)
  })

  it('listTracks returns every track, oldest first, whatever its status', () => {
    const repo = newRepo()
    const a = repo.createTrack(spec({ name: 'A' }))
    const b = repo.createTrack(spec({ name: 'B', status: 'picking' }))
    const c = repo.createTrack(spec({ name: 'C', status: 'archived' }))
    expect(repo.listTracks().map(t => t.id)).toEqual([a.id, b.id, c.id])
  })

  it('upsertProduct treats the same name and company as the same product, ignoring case and surrounding spaces', () => {
    const repo = newRepo()
    const first = repo.upsertProduct(product())
    const again = repo.upsertProduct(product({ name: ' cursor ', company: 'ANYSPHERE' }))
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt)
    expect(again.name).toBe('Cursor') // the first spelling stays
    const sameNameOtherCompany = repo.upsertProduct(product({ company: 'Someone Else' }))
    expect(sameNameOtherCompany.id).not.toBe(first.id)
    const otherNameSameCompany = repo.upsertProduct(product({ name: 'Cursor Web' }))
    expect(otherNameSameCompany.id).not.toBe(first.id)
    expect(new Set([first.id, sameNameOtherCompany.id, otherNameSameCompany.id]).size).toBe(3)
  })

  it('upsertProduct finds the same product under a slightly different spelling', () => {
    const { repo, db } = twinsRepo()
    const first = repo.upsertProduct(product({ name: '千问Go!', company: '阿里巴巴', status: 'candidate' }))
    const again = repo.upsertProduct(product({ name: '千问Go', company: '阿里巴巴', status: 'candidate' }))
    expect(again.id).toBe(first.id)
    expect(again.name).toBe('千问Go!') // the first spelling stays
    expect(db.prepare('SELECT COUNT(*) AS n FROM products').get()).toMatchObject({ n: 1 })
    // Another company is another product, however alike the names.
    expect(repo.upsertProduct(product({ name: '千问Go', company: '别家' })).id).not.toBe(first.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM products').get()).toMatchObject({ n: 2 })
  })

  it('upsertProduct picks the worked-on one, then the oldest, when several rows already read alike', () => {
    const { repo, db, insertAlike } = twinsRepo()
    insertAlike('a', 'Amoo 1', '阶跃星辰', 'candidate')
    insertAlike('b', 'Amoo-1', '阶跃星辰', 'tracking')
    insertAlike('c', 'Amoo 1!', '阶跃星辰', 'tracking')
    expect(repo.upsertProduct(product({ name: 'amoo1', company: '阶跃星辰', status: 'candidate' })).id).toBe('b')
    expect(db.prepare('SELECT COUNT(*) AS n FROM products').get()).toMatchObject({ n: 3 })
    repo.setProductStatus('b', 'archived')
    repo.setProductStatus('c', 'archived')
    expect(repo.upsertProduct(product({ name: 'amoo1', company: '阶跃星辰', status: 'candidate' })).id).toBe('a') // none worked on: the oldest
  })

  it('findSameProduct returns the worked-on twin, not a candidate one', () => {
    const { repo, insertAlike } = twinsRepo()
    insertAlike('wanted', '千问Go', '阿里巴巴', 'candidate')
    insertAlike('other-candidate', '千问 Go', '阿里巴巴', 'candidate')
    expect(repo.findSameProduct(repo.getProduct('wanted')!)).toBeNull() // two candidates are not a tracked product
    insertAlike('tracked', '千问Go!', '阿里巴巴', 'tracking')
    expect(repo.findSameProduct(repo.getProduct('wanted')!)).toMatchObject({ id: 'tracked', name: '千问Go!' })
    expect(repo.findSameProduct(repo.getProduct('other-candidate')!)?.id).toBe('tracked')
    expect(repo.findSameProduct(repo.getProduct('tracked')!)).toBeNull() // never itself
  })

  it('findSameProduct counts tracking, paused and baselining, takes the oldest of several, and skips archived ones and other companies', () => {
    const { repo, insertAlike } = twinsRepo()
    insertAlike('x', 'Muse', 'Meta', 'candidate')
    insertAlike('archived', 'M.use', 'Meta', 'archived')
    insertAlike('elsewhere', 'Muse', 'Muse AI', 'tracking')
    expect(repo.findSameProduct(repo.getProduct('x')!)).toBeNull()
    insertAlike('first-paused', 'MUSE!', 'Meta', 'paused')
    insertAlike('later-baselining', 'M-use', 'Meta', 'baselining')
    expect(repo.findSameProduct(repo.getProduct('x')!)?.id).toBe('first-paused') // the first one made, whichever worked-on status
    repo.setProductStatus('first-paused', 'archived')
    expect(repo.findSameProduct(repo.getProduct('x')!)?.id).toBe('later-baselining')
  })

  it('findFollowedByName matches spelling variants and ignores candidates', () => {
    const { repo, insertAlike } = twinsRepo()
    insertAlike('tracked', '千问Go!', '阿里巴巴', 'tracking')
    insertAlike('candidate', '千问Go', '阿里巴巴', 'candidate')
    insertAlike('archived', '千问 GO', '阿里巴巴', 'archived')
    insertAlike('elsewhere', '千问-Go', '别家', 'paused') // another company: the name alone is compared
    insertAlike('building', '千问 Go', '阿里巴巴云', 'baselining')
    insertAlike('plus', '千问Go Plus', '阿里巴巴', 'tracking')
    insertAlike('kimi-plus', 'Kimi+', '月之暗面', 'tracking')
    // Case, width, spaces and punctuation aside; tracking, paused and 建档中 count; oldest first.
    expect(repo.findFollowedByName('千问go').map(p => p.id)).toEqual(['tracked', 'elsewhere', 'building'])
    expect(repo.findFollowedByName(' 千问ＧＯ！ ').map(p => p.id)).toEqual(['tracked', 'elsewhere', 'building'])
    // Symbols are part of the name, and another name is another product.
    expect(repo.findFollowedByName('Kimi')).toEqual([])
    expect(repo.findFollowedByName('ｋｉｍｉ＋').map(p => p.id)).toEqual(['kimi-plus'])
    expect(repo.findFollowedByName('千问')).toEqual([])
    // A candidate or an archived row is not a product Outpost follows.
    repo.setProductStatus('tracked', 'archived')
    repo.setProductStatus('elsewhere', 'candidate')
    expect(repo.findFollowedByName('千问Go').map(p => p.id)).toEqual(['building'])
  })

  it('upsertProduct on an existing product refreshes its facts but never demotes status or erases what it already knows', () => {
    const repo = newRepo()
    const first = repo.upsertProduct(product({ status: 'tracking', iconPath: 'icons/a.png', dailyBudgetYuan: 2, officialDomains: ['cursor.com'] }))
    const again = repo.upsertProduct(product({ status: 'candidate', iconPath: null, dailyBudgetYuan: null, form: 'IDE + CLI', region: 'domestic', officialDomains: ['cursor.com', 'docs.cursor.com'] }))
    expect(again).toEqual({ ...first, form: 'IDE + CLI', region: 'domestic', officialDomains: ['cursor.com', 'docs.cursor.com'] })
    expect(again.status).toBe('tracking')
    expect(again.iconPath).toBe('icons/a.png')
    expect(again.dailyBudgetYuan).toBe(2)
    expect(repo.upsertProduct(product({ iconPath: 'icons/b.png', dailyBudgetYuan: 3 }))).toMatchObject({ iconPath: 'icons/b.png', dailyBudgetYuan: 3 })
  })

  it('upsertProduct honours a given id for a new product, and updates the row an existing id points at', () => {
    const repo = newRepo()
    const made = repo.upsertProduct({ ...product(), id: 'fixed-id' })
    expect(made.id).toBe('fixed-id')
    const renamed = repo.upsertProduct({ ...product({ name: 'Cursor 2', company: 'Anysphere Inc' }), id: 'fixed-id' })
    expect(renamed).toMatchObject({ id: 'fixed-id', name: 'Cursor 2', company: 'Anysphere Inc' })
    expect(repo.upsertProduct(product({ name: 'cursor 2', company: 'anysphere inc' })).id).toBe('fixed-id')
  })

  it('getProduct reads one product by id, or null when there is none', () => {
    const repo = newRepo()
    const p = repo.upsertProduct(product({ officialDomains: ['cursor.com', 'docs.cursor.com'] }))
    expect(repo.getProduct(p.id)).toEqual(p)
    expect(repo.getProduct('nope')).toBeNull()
  })

  it('setProductIcon sets the icon path and touches nothing else; a null clears it', () => {
    const repo = newRepo()
    const p = repo.upsertProduct(product({ status: 'candidate' }))
    repo.setProductIcon(p.id, '/data/icons/cursor.png')
    expect(repo.getProduct(p.id)).toEqual({ ...p, iconPath: '/data/icons/cursor.png' })
    repo.setProductIcon(p.id, null)
    expect(repo.getProduct(p.id)).toEqual(p)
    expect(() => repo.setProductIcon('nope', 'x.png')).toThrow(/unknown/)
  })

  it('setProductBudget sets or clears the product\'s own budget and touches nothing else', () => {
    const repo = newRepo()
    const p = repo.upsertProduct(product())
    repo.setProductBudget(p.id, 2.5)
    expect(repo.getProduct(p.id)).toEqual({ ...p, dailyBudgetYuan: 2.5 })
    repo.setProductBudget(p.id, null) // unlike upsertProduct, null does clear it
    expect(repo.getProduct(p.id)).toEqual(p)
    expect(() => repo.setProductBudget('nope', 1)).toThrow(/unknown/)
  })

  it('setProductStatus moves a product between statuses', () => {
    const repo = newRepo()
    const p = repo.upsertProduct(product({ status: 'candidate' }))
    repo.setProductStatus(p.id, 'baselining')
    const t = repo.createTrack(spec())
    repo.linkProduct(t.id, p.id)
    expect(repo.productsOfTrack(t.id)[0]!.status).toBe('baselining')
    repo.setProductStatus(p.id, 'tracking')
    expect(repo.productsOfTrack(t.id)[0]!.status).toBe('tracking')
    expect(() => repo.setProductStatus('nope', 'paused')).toThrow(/unknown/)
  })
})

describe('Repo: candidates', () => {
  const cand = (over: Partial<Omit<Candidate, 'id'>> = {}): Omit<Candidate, 'id'> => ({
    trackId: 't1', batchId: 'b1', productId: 'p1', tier: 'strong', oneLiner: '一句话', reason: '为什么推荐',
    heat: { foundCount: 12, datedWeekly: [1, 2, 3, 4, 5], trend: 'up', showBars: true }, selected: false, ...over,
  })

  it('stores a candidate with its heat and flags intact, and lists by batch or all', () => {
    const repo = newRepo()
    const a = repo.addCandidate(cand())
    const b = repo.addCandidate(cand({ batchId: 'b2', productId: 'p2', tier: 'consider', selected: true, heat: { foundCount: 0, datedWeekly: [], trend: 'unknown', showBars: false } }))
    repo.addCandidate(cand({ trackId: 't2', batchId: 'b9' }))
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).toMatchObject({ ...cand() })
    expect(repo.listCandidates('t1', 'b1')).toEqual([a])
    expect(repo.listCandidates('t1', 'b2')).toEqual([b])
    expect(repo.listCandidates('t1')).toEqual([a, b])
    expect(repo.listCandidates('t1', 'nope')).toEqual([])
  })

  it('setCandidateSelected records the user\'s pick of one candidate', () => {
    const repo = newRepo()
    const a = repo.addCandidate(cand({ selected: true }))
    const b = repo.addCandidate(cand({ productId: 'p2', selected: false }))
    repo.setCandidateSelected(a.id, false)
    repo.setCandidateSelected(b.id, true)
    expect(repo.listCandidates('t1').map(c => c.selected)).toEqual([false, true])
    expect(() => repo.setCandidateSelected('nope', true)).toThrow(/unknown/)
  })

  it('latestBatchId is the batch added last for that track, null when there is none', () => {
    const repo = newRepo()
    expect(repo.latestBatchId('t1')).toBeNull()
    repo.addCandidate(cand({ batchId: 'b1' }))
    repo.addCandidate(cand({ batchId: 'b1', productId: 'p2' }))
    expect(repo.latestBatchId('t1')).toBe('b1')
    repo.addCandidate(cand({ batchId: 'b2' }))
    repo.addCandidate(cand({ trackId: 't2', batchId: 'zzz' }))
    expect(repo.latestBatchId('t1')).toBe('b2')
    expect(repo.latestBatchId('t2')).toBe('zzz')
  })

  it('latestBatchId ignores candidates an identify run handed in', () => {
    const repo = newRepo()
    const run = (kind: 'recommend' | 'identify') => repo.createRun({ kind, date: '2026-11-25', trackId: 't1', productId: null }).id
    const first = run('recommend')
    repo.addCandidate(cand({ batchId: first }))
    const confirm = run('identify')
    repo.addCandidate(cand({ batchId: confirm, productId: 'p9' })) // the product typed by name, confirmed after the batch
    expect(repo.latestBatchId('t1')).toBe(first) // still the recommendation the user is picking from
    expect(repo.listCandidates('t1', confirm)).toHaveLength(1) // kept, under its own run
    const second = run('recommend')
    repo.addCandidate(cand({ batchId: second, productId: 'p2' }))
    repo.addCandidate(cand({ batchId: run('identify'), productId: 'p8' }))
    expect(repo.latestBatchId('t1')).toBe(second)
    // A track that has only had products confirmed by name has no batch at all.
    repo.addCandidate(cand({ trackId: 't3', batchId: confirm }))
    expect(repo.latestBatchId('t3')).toBeNull()
  })
})

describe('Repo: sources and findings', () => {
  it('stores a source with its nullable flags as given, and patches the verification fields', () => {
    const repo = newRepo()
    const s = repo.addSource(sourceSpec())
    expect(s).toMatchObject({ ...sourceSpec(), openedVia: null, quoteFound: null, supportsClaim: null })
    expect(repo.getSources([s.id])).toEqual([s])
    repo.updateSource(s.id, { openedVia: 'browser', quoteFound: true, supportsClaim: false, syndicationGroup: 'g1' })
    expect(repo.getSources([s.id])[0]).toEqual({ ...s, openedVia: 'browser', quoteFound: true, supportsClaim: false, syndicationGroup: 'g1' })
    repo.updateSource(s.id, { quoteFound: false })
    expect(repo.getSources([s.id])[0]).toMatchObject({ quoteFound: false, supportsClaim: false, openedVia: 'browser' })
    expect(() => repo.updateSource(s.id, { url: 'x' } as never)).toThrow(/cannot update/)
    expect(() => repo.updateSource('nope', { quoteFound: true })).toThrow(/unknown/)
  })

  it('getSources returns sources in the order asked, skipping unknown ids', () => {
    const repo = newRepo()
    const a = repo.addSource(sourceSpec({ url: 'https://a.example/1' }))
    const b = repo.addSource(sourceSpec({ url: 'https://b.example/1' }))
    const c = repo.addSource(sourceSpec({ url: 'https://c.example/1' }))
    expect(repo.getSources([c.id, 'missing', a.id]).map(s => s.url)).toEqual([c.url, a.url])
    expect(repo.getSources([])).toEqual([])
    expect(repo.getSources([b.id, b.id])).toEqual([b])
  })

  it('stores a finding with arrays and booleans intact and stamps createdAt', () => {
    const repo = newRepo()
    const f = repo.addFinding(findingSpec({ sourceIds: ['s1', 's2'], dimensions: ['pricing', 'privacy'], inference: true, late: true }))
    expect(f).toEqual({ ...findingSpec({ sourceIds: ['s1', 's2'], dimensions: ['pricing', 'privacy'], inference: true, late: true }), id: f.id, createdAt: '2026-11-25T08:00:00.000Z' })
    expect(repo.findingsOfProduct('p1')).toEqual([f])
  })

  it('updateFinding patches status, note, deadline and the read and late flags', () => {
    const repo = newRepo()
    const f = repo.addFinding(findingSpec())
    repo.updateFinding(f.id, { status: 'unconfirmed', statusNote: '原文打不开', unconfirmedUntil: '2026-12-02T08:00:00.000Z' })
    expect(repo.findingsOfProduct('p1')[0]).toEqual({ ...f, status: 'unconfirmed', statusNote: '原文打不开', unconfirmedUntil: '2026-12-02T08:00:00.000Z' })
    repo.updateFinding(f.id, { read: true, late: true })
    expect(repo.findingsOfProduct('p1')[0]).toMatchObject({ read: true, late: true, status: 'unconfirmed' })
    repo.updateFinding(f.id, { status: 'verified', statusNote: null, unconfirmedUntil: null, read: false })
    expect(repo.findingsOfProduct('p1')[0]).toMatchObject({ status: 'verified', statusNote: null, unconfirmedUntil: null, read: false, late: true })
    expect(() => repo.updateFinding(f.id, { headline: 'x' } as never)).toThrow(/cannot update/)
    expect(() => repo.updateFinding('nope', { read: true })).toThrow(/unknown/)
  })

  it('updateFinding can replace the source list, which is how a corroborating source is attached', () => {
    const repo = newRepo()
    const f = repo.addFinding(findingSpec({ sourceIds: ['s1'] }))
    repo.updateFinding(f.id, { sourceIds: ['s1', 's2'] })
    expect(repo.findingsOfProduct('p1')[0]).toEqual({ ...f, sourceIds: ['s1', 's2'] })
  })

  it('findingsOfDate returns the findings of that day, including one that landed after midnight', () => {
    const repo = newRepo()
    const day = repo.createRun({ kind: 'daily', date: '2026-11-25', trackId: null, productId: 'p1' })
    const nextDay = repo.createRun({ kind: 'daily', date: '2026-11-26', trackId: null, productId: 'p1' })
    const a = repo.addFinding(findingSpec({ runId: day.id }))
    time = new Date('2026-11-26T00:30:00.000Z') // a slow run finishing past midnight still belongs to its own day
    const b = repo.addFinding(findingSpec({ runId: day.id, headline: '迟到的', late: true, dedupeKey: 'k2' }))
    const c = repo.addFinding(findingSpec({ runId: nextDay.id, headline: '第二天', dedupeKey: 'k3' }))
    expect(repo.findingsOfDate('2026-11-25')).toEqual([a, b])
    expect(repo.findingsOfDate('2026-11-26')).toEqual([c])
    expect(repo.findingsOfDate('2026-11-24')).toEqual([])
  })

  it('findingsVerifiedOn returns the findings verified on that day, whichever day\'s brief they belong to', () => {
    const repo = newRepo()
    const run = repo.createRun({ kind: 'daily', date: '2026-11-25', trackId: null, productId: 'p1' })
    const sameDay = repo.addFinding(findingSpec({ runId: run.id, dedupeKey: 'a' }))
    const promoted = repo.addFinding(findingSpec({ runId: run.id, headline: '后来转正', status: 'unconfirmed', dedupeKey: 'b' }))
    const waiting = repo.addFinding(findingSpec({ runId: run.id, headline: '还在等', status: 'unconfirmed', dedupeKey: 'c' }))
    repo.updateFinding(sameDay.id, { status: 'verified', verifiedOn: '2026-11-25' })
    repo.updateFinding(promoted.id, { status: 'verified', verifiedOn: '2026-11-27' })
    expect(repo.findingsVerifiedOn('2026-11-25').map(f => f.id)).toEqual([sameDay.id])
    expect(repo.findingsVerifiedOn('2026-11-27')).toEqual([{ ...promoted, status: 'verified', verifiedOn: '2026-11-27' }])
    expect(repo.findingsVerifiedOn('2026-11-26')).toEqual([])
    expect(repo.findingsOfDate('2026-11-25').map(f => f.id)).toEqual([sameDay.id, promoted.id, waiting.id]) // still in the brief of its own day
  })

  it('getFinding returns one finding by id, or null', () => {
    const repo = newRepo()
    const f = repo.addFinding(findingSpec())
    repo.updateFinding(f.id, { status: 'verified', verifiedOn: '2026-11-25' })
    expect(repo.getFinding(f.id)).toEqual({ ...f, status: 'verified', verifiedOn: '2026-11-25' })
    expect(repo.getFinding('nope')).toBeNull()
  })

  it('findingsOfDate falls back to the local day of creation when the run is unknown', () => {
    const repo = newRepo()
    const f = repo.addFinding(findingSpec({ runId: 'no-such-run' }))
    expect(repo.findingsOfDate(localDate(time))).toEqual([f])
  })

  it('findingsOfProduct: newest first, only that product, and only the last N days when asked', () => {
    const repo = newRepo()
    time = new Date('2026-11-01T08:00:00.000Z')
    const old = repo.addFinding(findingSpec({ headline: '很久以前', dedupeKey: 'old' }))
    time = new Date('2026-11-20T08:00:00.000Z')
    const mid = repo.addFinding(findingSpec({ headline: '五天前', dedupeKey: 'mid' }))
    repo.addFinding(findingSpec({ productId: 'p2', headline: '别的产品', dedupeKey: 'other' }))
    time = new Date('2026-11-25T08:00:00.000Z')
    const fresh = repo.addFinding(findingSpec({ headline: '今天', dedupeKey: 'fresh' }))
    expect(repo.findingsOfProduct('p1').map(f => f.id)).toEqual([fresh.id, mid.id, old.id])
    expect(repo.findingsOfProduct('p1', 14).map(f => f.id)).toEqual([fresh.id, mid.id])
    expect(repo.findingsOfProduct('p1', 5).map(f => f.id)).toEqual([fresh.id, mid.id]) // the boundary is inclusive
    expect(repo.findingsOfProduct('p1', 4).map(f => f.id)).toEqual([fresh.id])
    expect(repo.findingsOfProduct('p1', 0).map(f => f.id)).toEqual([fresh.id])
    expect(repo.findingsOfProduct('nobody')).toEqual([])
    expect(() => repo.findingsOfProduct('p1', -1)).toThrow(RangeError)
  })

  it('feeds a duplicate check: recent findings of a product plus their sources give headline, key and urls', () => {
    const repo = newRepo()
    const s1 = repo.addSource(sourceSpec({ url: 'https://a.example/x' }))
    const s2 = repo.addSource(sourceSpec({ url: 'https://b.example/y' }))
    repo.addFinding(findingSpec({ sourceIds: [s1.id, s2.id] }))
    const recent = repo.findingsOfProduct('p1', 14).map(f => ({ productId: f.productId, dedupeKey: f.dedupeKey, urls: repo.getSources(f.sourceIds).map(s => s.url), headline: f.headline }))
    expect(recent).toEqual([{ productId: 'p1', dedupeKey: 'cursor-pricing', urls: ['https://a.example/x', 'https://b.example/y'], headline: 'Cursor 推出新定价' }])
  })

  it('openUnconfirmed returns that product\'s unconfirmed findings, oldest first, including ones past their deadline', () => {
    const repo = newRepo()
    const a = repo.addFinding(findingSpec({ status: 'unconfirmed', unconfirmedUntil: '2026-11-18T00:00:00.000Z', dedupeKey: 'a' }))
    repo.addFinding(findingSpec({ status: 'verified', dedupeKey: 'b' }))
    repo.addFinding(findingSpec({ status: 'unproven', dedupeKey: 'c' }))
    repo.addFinding(findingSpec({ status: 'withdrawn', dedupeKey: 'd' }))
    repo.addFinding(findingSpec({ status: 'pending', dedupeKey: 'e' }))
    repo.addFinding(findingSpec({ productId: 'p2', status: 'unconfirmed', dedupeKey: 'f' }))
    const e = repo.addFinding(findingSpec({ status: 'unconfirmed', unconfirmedUntil: '2026-12-02T00:00:00.000Z', dedupeKey: 'g' }))
    expect(repo.openUnconfirmed('p1').map(f => f.id)).toEqual([a.id, e.id])
    repo.updateFinding(a.id, { status: 'unproven' })
    expect(repo.openUnconfirmed('p1').map(f => f.id)).toEqual([e.id])
  })
})

describe('Repo: cards and facts', () => {
  it('appends card versions, and latestCards gives only the newest version of each dimension', () => {
    const repo = newRepo()
    repo.addCardVersion(cardAt(1))
    repo.addCardVersion(cardAt(1, { dimension: 'positioning', summary: '定位 v1' }))
    repo.addCardVersion(cardAt(2, { summary: '价格 v2', inferenceSpans: [{ start: 0, end: 2 }], addedSpans: [{ start: 3, end: 5 }] }))
    repo.addCardVersion(cardAt(1, { productId: 'p2' }))
    const latest = repo.latestCards('p1')
    expect(latest.map(c => [c.dimension, c.version])).toEqual([['pricing', 2], ['positioning', 1]]) // dimensions keep the order they first got a card
    expect(latest[0]).toEqual(cardAt(2, { summary: '价格 v2', inferenceSpans: [{ start: 0, end: 2 }], addedSpans: [{ start: 3, end: 5 }] }))
    expect(repo.latestCards('nobody')).toEqual([])
    repo.addCardVersion(cardAt(3))
    expect(repo.latestCards('p1').find(c => c.dimension === 'pricing')!.version).toBe(3)
  })

  it('cardHistory lists every version of one dimension, oldest first', () => {
    const repo = newRepo()
    repo.addCardVersion(cardAt(2))
    repo.addCardVersion(cardAt(1))
    repo.addCardVersion(cardAt(3))
    repo.addCardVersion(cardAt(1, { dimension: 'positioning' }))
    expect(repo.cardHistory('p1', 'pricing').map(c => c.version)).toEqual([1, 2, 3])
    expect(repo.cardHistory('p1', 'positioning').map(c => c.version)).toEqual([1])
    expect(repo.cardHistory('p1', 'nothing')).toEqual([])
  })

  it('cardDimensions lists every dimension some card or card edit was written for', () => {
    const repo = newRepo()
    expect(repo.cardDimensions()).toEqual(new Set())
    repo.addCardVersion(cardAt(1))
    repo.addCardVersion(cardAt(1, { productId: 'p2', dimension: 'custom-75286237' }))
    repo.addCardEdit({ productId: 'p1', dimension: 'audience', summary: '', bullets: [], body: '', sourceIds: [], inferenceSpans: [], changeNote: '', findingIds: [] })
    expect(repo.cardDimensions()).toEqual(new Set(['pricing', 'custom-75286237', 'audience']))
  })

  it('refuses to overwrite a card version that already exists', () => {
    const repo = newRepo()
    repo.addCardVersion(cardAt(1))
    expect(() => repo.addCardVersion(cardAt(1, { summary: '改写' }))).toThrow()
    expect(repo.cardHistory('p1', 'pricing')[0]!.summary).toBe('第 1 版')
  })

  it('keeps card edits pending until their status is set', () => {
    const repo = newRepo()
    const base = { productId: 'p1', dimension: 'pricing', summary: '摘要', bullets: ['a', 'b'], body: '正文[1]', sourceIds: ['s1'], inferenceSpans: [{ start: 0, end: 1 }], changeNote: '新增', findingIds: ['f1'] }
    const one = repo.addCardEdit(base)
    const two = repo.addCardEdit({ ...base, dimension: 'positioning' })
    repo.addCardEdit({ ...base, productId: 'p2' })
    expect(one).toEqual({ ...base, id: one.id, status: 'pending' })
    expect(repo.pendingCardEdits('p1')).toEqual([one, two])
    repo.setCardEditStatus(one.id, 'applied')
    expect(repo.pendingCardEdits('p1')).toEqual([two])
    repo.setCardEditStatus(two.id, 'rejected')
    expect(repo.pendingCardEdits('p1')).toEqual([])
    expect(() => repo.setCardEditStatus('nope', 'applied')).toThrow(/unknown/)
  })

  it('addFacts numbers versions per product and latestFacts returns the newest', () => {
    const repo = newRepo()
    expect(repo.latestFacts('p1')).toBeNull()
    const facts = { productId: 'p1', form: 'IDE', platforms: 'macOS / Windows', price: '$20/月', firstReleased: '2023', rivals: ['Windsurf', 'Zed'] }
    const v1 = repo.addFacts(facts)
    expect(v1).toEqual({ ...facts, version: 1, createdAt: '2026-11-25T08:00:00.000Z' })
    time = new Date('2026-11-26T08:00:00.000Z')
    const v2 = repo.addFacts({ ...facts, price: '$25/月' })
    expect(v2).toMatchObject({ version: 2, price: '$25/月', createdAt: '2026-11-26T08:00:00.000Z' })
    expect(repo.addFacts({ ...facts, productId: 'p2' }).version).toBe(1)
    expect(repo.latestFacts('p1')).toEqual(v2)
  })
})

describe('Repo: briefs, runs, spending, settings', () => {
  const brief = (over: Partial<Brief> = {}): Brief => ({ date: '2026-11-25', gist: '今天一条重要更新', findingIds: ['f1'], minorIds: ['f2'], quietProductIds: ['p3'], skipped: [{ productId: 'p4', reason: '今日总预算已用完' }], costYuan: 1.5, createdAt: '2026-11-25T10:00:00.000Z', updatedAt: '2026-11-25T10:00:00.000Z', ...over })

  it('putBrief stores a brief by date, replaces it on a second put, and getBrief is null for a missing day', () => {
    const repo = newRepo()
    expect(repo.getBrief('2026-11-25')).toBeNull()
    repo.putBrief(brief())
    expect(repo.getBrief('2026-11-25')).toEqual(brief())
    repo.putBrief(brief({ gist: '补了迟到的', findingIds: ['f1', 'f9'], updatedAt: '2026-11-25T12:00:00.000Z' }))
    expect(repo.getBrief('2026-11-25')).toEqual(brief({ gist: '补了迟到的', findingIds: ['f1', 'f9'], updatedAt: '2026-11-25T12:00:00.000Z' }))
    repo.putBrief(brief({ date: '2026-11-24' }))
    expect(repo.getBrief('2026-11-24')!.date).toBe('2026-11-24')
    expect(repo.getBrief('2026-11-25')!.gist).toBe('补了迟到的')
  })

  it('previousBriefDate is the latest day before the given one that has a brief', () => {
    const repo = newRepo()
    expect(repo.previousBriefDate('2026-11-25')).toBeNull()
    for (const date of ['2026-11-20', '2026-11-23', '2026-11-25']) repo.putBrief(brief({ date }))
    expect(repo.previousBriefDate('2026-11-25')).toBe('2026-11-23')
    expect(repo.previousBriefDate('2026-11-24')).toBe('2026-11-23')
    expect(repo.previousBriefDate('2026-11-23')).toBe('2026-11-20')
    expect(repo.previousBriefDate('2026-11-20')).toBeNull()
  })

  it('latestRun is the run of a kind made last for a track or product; activeRuns are those queued or running, newest first', () => {
    const repo = newRepo()
    const run = (kind: 'recommend' | 'baseline' | 'daily', about: { trackId?: string; productId?: string }, status: 'queued' | 'running' | 'done') => {
      const r = repo.createRun({ kind, date: '2026-11-25', trackId: about.trackId ?? null, productId: about.productId ?? null })
      repo.updateRun(r.id, { status })
      return r.id
    }
    const r1 = run('recommend', { trackId: 't1' }, 'done')
    const r2 = run('recommend', { trackId: 't1' }, 'running')
    run('recommend', { trackId: 't2' }, 'queued')
    const b1 = run('baseline', { productId: 'p1' }, 'running')
    const d1 = run('daily', { productId: 'p1' }, 'done')
    expect(repo.latestRun('recommend', { trackId: 't1' })!.id).toBe(r2)
    expect(repo.latestRun('baseline', { productId: 'p1' })!.id).toBe(b1)
    expect(repo.latestRun('daily', { productId: 'p1' })!.id).toBe(d1)
    expect(repo.latestRun('daily', { productId: 'p2' })).toBeNull()
    expect(repo.latestRun('recommend', { trackId: 't3' })).toBeNull()
    expect(repo.activeRuns('p1').map(r => r.id)).toEqual([b1])
    expect(repo.activeRuns().map(r => r.kind)).toEqual(['baseline', 'recommend', 'recommend'])
    expect(repo.activeRuns().some(r => r.id === r1)).toBe(false)
  })

  it('createRun starts a run queued with nothing spent', () => {
    const repo = newRepo()
    const r = repo.createRun({ kind: 'daily', date: '2026-11-25', trackId: 't1', productId: 'p1' })
    expect(r).toEqual({ id: r.id, kind: 'daily', date: '2026-11-25', trackId: 't1', productId: 'p1', sessionId: null, status: 'queued', startedAt: null, endedAt: null, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, costYuan: 0, error: null, progress: null, subject: null })
    // A run about something typed by the user (a product named by hand) keeps those words.
    const named = repo.createRun({ kind: 'identify', date: '2026-11-25', trackId: 't1', productId: null, subject: 'Gemini Agent' })
    expect(repo.getRun(named.id)).toEqual({ ...named, subject: 'Gemini Agent' })
  })

  it('getRun reads one run as it is now, or null', () => {
    const repo = newRepo()
    const r = repo.createRun({ kind: 'baseline', date: '2026-11-25', trackId: null, productId: 'p1' })
    repo.updateRun(r.id, { status: 'running', progress: { done: 2, total: 6 } })
    expect(repo.getRun(r.id)).toEqual({ ...r, status: 'running', progress: { done: 2, total: 6 } })
    expect(repo.getRun('nope')).toBeNull()
  })

  it('updateRun patches any field of a run, including usage and progress', () => {
    const repo = newRepo()
    const r = repo.createRun({ kind: 'baseline', date: '2026-11-25', trackId: null, productId: 'p1' })
    repo.updateRun(r.id, { status: 'running', sessionId: 'outpost-baseline-abcd1234', startedAt: '2026-11-25T08:00:00.000Z', progress: { done: 1, total: 6 } })
    repo.updateRun(r.id, { status: 'done', endedAt: '2026-11-25T08:10:00.000Z', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 }, costYuan: 0.42, progress: null })
    repo.updateRun(r.id, { status: 'failed', error: 'boom' })
    expect(repo.runsOfDate('2026-11-25')).toEqual([{ ...r, status: 'failed', sessionId: 'outpost-baseline-abcd1234', startedAt: '2026-11-25T08:00:00.000Z', endedAt: '2026-11-25T08:10:00.000Z', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 }, costYuan: 0.42, error: 'boom', progress: null }])
    expect(() => repo.updateRun('nope', { status: 'done' })).toThrow(/unknown/)
    expect(() => repo.updateRun(r.id, { id: 'other' })).toThrow(/cannot update/)
  })

  it('runsOfDate filters by day and optionally kind; listRuns is newest first from a start date', () => {
    const repo = newRepo()
    const a = repo.createRun({ kind: 'daily', date: '2026-11-24', trackId: null, productId: 'p1' })
    const b = repo.createRun({ kind: 'daily', date: '2026-11-25', trackId: null, productId: 'p1' })
    const c = repo.createRun({ kind: 'verify', date: '2026-11-25', trackId: null, productId: 'p1' })
    const d = repo.createRun({ kind: 'daily', date: '2026-11-26', trackId: null, productId: 'p2' })
    expect(repo.runsOfDate('2026-11-25').map(r => r.id)).toEqual([b.id, c.id])
    expect(repo.runsOfDate('2026-11-25', 'daily').map(r => r.id)).toEqual([b.id])
    expect(repo.runsOfDate('2026-11-25', 'recommend')).toEqual([])
    expect(repo.listRuns('2026-11-25').map(r => r.id)).toEqual([d.id, c.id, b.id])
    expect(repo.listRuns('2026-11-24').map(r => r.id)).toEqual([d.id, c.id, b.id, a.id])
    expect(repo.listRuns('2026-12-01')).toEqual([])
  })

  it('spentOn adds up the cost of that day\'s runs, optionally for one product', () => {
    const repo = newRepo()
    const run = (date: string, productId: string | null, costYuan: number) => { const r = repo.createRun({ kind: 'daily', date, trackId: null, productId }); repo.updateRun(r.id, { costYuan }) }
    expect(repo.spentOn('2026-11-25')).toBe(0)
    run('2026-11-25', 'p1', 0.1)
    run('2026-11-25', 'p1', 0.2)
    run('2026-11-25', 'p2', 1.5)
    run('2026-11-25', null, 0.25) // a track-level run has no product
    run('2026-11-24', 'p1', 9)
    run('2026-11-26', 'p1', 9)
    expect(repo.spentOn('2026-11-25')).toBe(2.05)
    expect(repo.spentOn('2026-11-25', 'p1')).toBe(0.3) // no floating-point crumbs
    expect(repo.spentOn('2026-11-25', 'p2')).toBe(1.5)
    expect(repo.spentOn('2026-11-25', 'p3')).toBe(0)
    expect(repo.spentOn('2026-11-27')).toBe(0)
  })

  it('settings round-trip strings, numbers, objects and null; missing is undefined; undefined removes', () => {
    const repo = newRepo()
    expect(repo.getSetting('lastCompletedDailyDate')).toBeUndefined()
    repo.setSetting('lastCompletedDailyDate', '2026-11-24')
    repo.setSetting('n', 3)
    repo.setSetting('obj', { a: [1, 2], b: { c: true } })
    repo.setSetting('nothing', null)
    expect(repo.getSetting<string>('lastCompletedDailyDate')).toBe('2026-11-24')
    expect(repo.getSetting<number>('n')).toBe(3)
    expect(repo.getSetting('obj')).toEqual({ a: [1, 2], b: { c: true } })
    expect(repo.getSetting('nothing')).toBeNull()
    repo.setSetting('lastCompletedDailyDate', '2026-11-25')
    expect(repo.getSetting('lastCompletedDailyDate')).toBe('2026-11-25')
    repo.setSetting('n', undefined)
    expect(repo.getSetting('n')).toBeUndefined()
  })
})

describe('Repo: storage format', () => {
  it('keeps arrays and objects as JSON text, booleans as 0 or 1, and times as ISO strings', () => {
    const repo = newRepo()
    const db = opened[0]!
    const t = repo.createTrack(spec())
    repo.addFinding(findingSpec({ read: true, inference: true, dimensions: ['a', 'b'] }))
    repo.addCandidate({ trackId: t.id, batchId: 'b', productId: 'p', tier: 'strong', oneLiner: '', reason: '', heat: { foundCount: 1, datedWeekly: [], trend: 'flat', showBars: false }, selected: true })
    repo.addSource(sourceSpec({ isOfficial: false, quoteFound: false }))
    expect(db.prepare('SELECT dimensions, created_at FROM tracks').get()).toEqual({ dimensions: JSON.stringify(spec().dimensions), created_at: '2026-11-25T08:00:00.000Z' })
    expect(db.prepare('SELECT read, inference, late, dimensions FROM findings').get()).toEqual({ read: 1, inference: 1, late: 0, dimensions: '["a","b"]' })
    expect(db.prepare('SELECT selected, heat FROM candidates').get()).toEqual({ selected: 1, heat: JSON.stringify({ foundCount: 1, datedWeekly: [], trend: 'flat', showBars: false }) })
    expect(db.prepare('SELECT is_official, quote_found, supports_claim FROM sources').get()).toEqual({ is_official: 0, quote_found: 0, supports_claim: null })
  })

  it('does not require rows to exist for the ids other rows mention (no foreign keys)', () => {
    const repo = newRepo()
    expect(() => repo.createRun({ kind: 'daily', date: '2026-11-25', trackId: 'no-track', productId: 'no-product' })).not.toThrow()
    expect(() => repo.addFinding(findingSpec({ productId: 'no-product', runId: 'no-run' }))).not.toThrow()
  })

  it('composes with Db.atomic: a failed multi-step write leaves no half-saved product', () => {
    const repo = newRepo()
    const db = opened[0]!
    const t = repo.createTrack(spec())
    expect(() => db.atomic(() => {
      const p = repo.upsertProduct(product())
      repo.linkProduct(t.id, p.id)
      repo.addCandidate({ trackId: t.id, batchId: 'b', productId: p.id, tier: 'strong', oneLiner: '', reason: '', heat: { foundCount: 0, datedWeekly: [], trend: 'unknown', showBars: false }, selected: false })
      throw new Error('crash mid-way')
    })).toThrow('crash mid-way')
    expect(repo.productsOfTrack(t.id)).toEqual([])
    expect(repo.listCandidates(t.id)).toEqual([])
    expect(repo.upsertProduct(product()).createdAt).toBe('2026-11-25T08:00:00.000Z')
  })
})
