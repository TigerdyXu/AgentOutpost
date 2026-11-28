import type { DatabaseSync } from 'node:sqlite'

/**
 * The schema, one script per version. `PRAGMA user_version` holds how many have been applied, so a database made by an
 * earlier build only runs the scripts it has not seen. Never edit a script that has shipped: append a new one.
 *
 * Conventions: arrays and objects are JSON text, booleans are 0/1, times are ISO strings, ids are UUID text. There are
 * no foreign keys on purpose: a run or finding may name a product or run that is not in the table (tests and
 * half-built flows do, and so do the runs of a deleted product). Rows are deleted only when the user deletes a track or a
 * product (`Repo.deleteTrack`, `Repo.deleteProduct`). Tables with an implicit `rowid` are listed in insertion order.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE tracks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    brief TEXT NOT NULL,
    dimensions TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    company TEXT NOT NULL,
    region TEXT NOT NULL,
    form TEXT NOT NULL,
    icon_path TEXT,
    official_domains TEXT NOT NULL,
    status TEXT NOT NULL,
    daily_budget_yuan REAL,
    created_at TEXT NOT NULL
  );
  -- The same name at the same company is the same product.
  CREATE UNIQUE INDEX products_identity ON products (name COLLATE NOCASE, company COLLATE NOCASE);

  CREATE TABLE track_products (
    track_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    PRIMARY KEY (track_id, product_id)
  );
  CREATE INDEX track_products_product ON track_products (product_id);

  CREATE TABLE candidates (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    batch_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    one_liner TEXT NOT NULL,
    reason TEXT NOT NULL,
    heat TEXT NOT NULL,
    selected INTEGER NOT NULL
  );
  CREATE INDEX candidates_track ON candidates (track_id, batch_id);

  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    publisher TEXT NOT NULL,
    published_at TEXT,
    kind TEXT NOT NULL,
    is_official INTEGER NOT NULL,
    quote TEXT NOT NULL,
    syndication_group TEXT,
    opened_via TEXT,
    quote_found INTEGER,
    supports_claim INTEGER
  );

  CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    headline TEXT NOT NULL,
    why TEXT NOT NULL,
    importance TEXT NOT NULL,
    claim_kind TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    status TEXT NOT NULL,
    status_note TEXT,
    unconfirmed_until TEXT,
    dimensions TEXT NOT NULL,
    inference INTEGER NOT NULL,
    read INTEGER NOT NULL,
    late INTEGER NOT NULL,
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- Local calendar day of the brief this finding belongs to: its run's date, else the day it was created.
    date TEXT NOT NULL
  );
  CREATE INDEX findings_product ON findings (product_id, created_at);
  CREATE INDEX findings_date ON findings (date);
  CREATE INDEX findings_open ON findings (product_id) WHERE status = 'unconfirmed';

  CREATE TABLE card_versions (
    product_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    version INTEGER NOT NULL,
    summary TEXT NOT NULL,
    bullets TEXT NOT NULL,
    body TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    inference_spans TEXT NOT NULL,
    added_spans TEXT NOT NULL,
    change_note TEXT NOT NULL,
    finding_ids TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (product_id, dimension, version)
  );

  CREATE TABLE card_edits (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    summary TEXT NOT NULL,
    bullets TEXT NOT NULL,
    body TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    inference_spans TEXT NOT NULL,
    change_note TEXT NOT NULL,
    finding_ids TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE INDEX card_edits_product ON card_edits (product_id, status);

  CREATE TABLE facts (
    product_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    form TEXT NOT NULL,
    platforms TEXT NOT NULL,
    price TEXT NOT NULL,
    first_released TEXT NOT NULL,
    rivals TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (product_id, version)
  );

  CREATE TABLE briefs (
    date TEXT PRIMARY KEY,
    gist TEXT NOT NULL,
    finding_ids TEXT NOT NULL,
    minor_ids TEXT NOT NULL,
    quiet_product_ids TEXT NOT NULL,
    skipped TEXT NOT NULL,
    cost_yuan REAL NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    date TEXT NOT NULL,
    track_id TEXT,
    product_id TEXT,
    session_id TEXT,
    status TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    usage TEXT NOT NULL,
    cost_yuan REAL NOT NULL,
    error TEXT,
    progress TEXT
  );
  CREATE INDEX runs_date ON runs (date);

  CREATE TABLE settings_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: the day a finding was verified, so a 「待确认」 finding confirmed days later shows in that day's brief (design §7.4).
  `
  ALTER TABLE findings ADD COLUMN verified_on TEXT;
  CREATE INDEX findings_verified_on ON findings (verified_on);
  `,
  // 3: what the user typed that a run is about: the name of a product added by hand (M1.2), shown in 运行记录 until the
  // product is known.
  `
  ALTER TABLE runs ADD COLUMN subject TEXT;
  `,
  // 4: whether the checker, having seen the page, agrees that the product's maker published it (M1.6); null for every
  // source checked before, which therefore no longer counts as official.
  `
  ALTER TABLE sources ADD COLUMN official_confirmed INTEGER;
  `,
  // 5: each drawing of a track's map and its one-sentence 格局 (M2.1), oldest first; a deleted track's go with it.
  `
  CREATE TABLE landscapes (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    date TEXT NOT NULL,
    gist TEXT NOT NULL,
    axes TEXT NOT NULL,
    positions TEXT NOT NULL,
    run_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX landscapes_track ON landscapes (track_id, created_at);
  `,
]

/**
 * Brings `db` up to the last of `migrations`, running each one it has not seen inside its own transaction together
 * with the `user_version` bump, so a script that fails leaves the database exactly as the previous one left it.
 * @throws When the database was written by a newer build (`user_version` beyond `migrations`), or a script fails.
 */
export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): void {
  const current = Number(db.prepare('PRAGMA user_version').get()!.user_version)
  if (current > migrations.length) throw new Error(`Database schema version ${current} is newer than this build understands (${migrations.length}); update the plugin`)
  for (let version = current; version < migrations.length; version++) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migrations[version]!)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}
