import { Database } from "bun:sqlite"
import type { Row, Sql, SqlValue } from "@p-lens-relay/sql"

/** A SQLite file as the port, and the way to close it. */
export type SqliteFile = { readonly sql: Sql; readonly close: () => void }

/**
 * A SQLite file by `bun:sqlite`, made if missing: written ahead to its log,
 * so that a reading never waits on a writing, and waiting a while on a
 * lock rather than failing at once.
 */
export const sqliteFile = (path: string): SqliteFile => {
  const database = new Database(path, { create: true, strict: true })
  database.run("PRAGMA journal_mode = WAL")
  database.run("PRAGMA busy_timeout = 5000")
  return {
    sql: {
      run: (query, ...params) => database.query(query).all(...(params as SqlValue[])) as readonly Row[],
      atomically: (work) => database.transaction(work)(),
    },
    close: () => database.close(),
  }
}
