import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { lockSync } from 'proper-lockfile'
import { migrate } from './migrations.ts'

/** The slice of SQLite that the repo needs. */
export interface Db {
  /**
   * Runs `fn` in a savepoint, so blocks nest: an error rolls back everything `fn` wrote and is rethrown, and an inner
   * block that failed does not undo the outer block's earlier work (unless the error is let through).
   * `fn` must be synchronous; an async one would commit before it finished, so it is refused and rolled back.
   */
  atomic<T>(fn: () => T): T
  prepare(sql: string): StatementSync
  close(): void
}

/**
 * Opens (creating if needed) the SQLite file at `path` and brings its schema up to date. The directory is created
 * 0700 if it does not exist yet and the file is 0600 from its first byte (SQLite gives the `-wal`/`-shm` files the same
 * permissions). Journal mode is WAL with `synchronous=FULL`, so a committed write survives a crash or power loss.
 * Only opens the file: whoever owns the data directory takes the lock first, see `lockDataDir`.
 * @throws When the schema is newer than this build or a migration fails; the handle is closed first.
 */
export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  closeSync(openSync(path, 'a', 0o600)) // create it private rather than chmod after SQLite made it world-readable
  chmodSync(path, 0o600)
  const raw = new DatabaseSync(path)
  try {
    raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000')
    migrate(raw)
  } catch (error) {
    raw.close()
    throw error
  }
  let depth = 0
  let closed = false
  return {
    atomic<T>(fn: () => T): T {
      const savepoint = `outpost_atomic_${depth}`
      raw.exec(`SAVEPOINT ${savepoint}`)
      depth++
      try {
        const value = fn()
        if (typeof (value as { then?: unknown } | null)?.then === 'function') throw new TypeError('Db.atomic needs a synchronous callback')
        raw.exec(`RELEASE ${savepoint}`)
        return value
      } catch (error) {
        // If SQLite already rolled the whole transaction back (disk full, say) the savepoint is gone; the original error is the one to report.
        try { raw.exec(`ROLLBACK TO ${savepoint}`); raw.exec(`RELEASE ${savepoint}`) } catch { /* see above */ }
        throw error
      } finally {
        depth--
      }
    },
    prepare: sql => raw.prepare(sql),
    close() {
      if (closed) return
      closed = true
      raw.close()
    },
  }
}

/**
 * Takes the exclusive lock on the data directory (created 0700 if missing) so that a second copy of the plugin, or a
 * second dsh, cannot open the same database and write at the same time. Returns the function that releases it.
 * The lock lives inside the directory (`outpost.lock`), not beside it. A lock whose holder died is taken over after 30 s.
 * @param onCompromised - Called if the lock could not be refreshed in time (a laptop that slept longer than the stale
 *   window, say) and another process could now hold it. Without one the error is dropped: proper-lockfile's default
 *   is to throw from a timer, which would take the whole host down.
 * @throws When another process holds the lock (`ELOCKED`).
 */
export function lockDataDir(dir: string, onCompromised: (error: Error) => void = () => {}): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return lockSync(dir, { stale: 30_000, lockfilePath: join(dir, 'outpost.lock'), onCompromised })
}
