import { Database } from "bun:sqlite"
import type { Row, Sql, SqlValue } from "./index"

/** SQLite in memory by `bun:sqlite`, for tests: made ready by whatever prepares the tables. */
export const memorySql = (prepare: (sql: Sql) => void): Sql => {
  const database = new Database(":memory:", { strict: true })
  const sql: Sql = {
    run: (query, ...params) => database.query(query).all(...(params as SqlValue[])) as readonly Row[],
    atomically: (work) => database.transaction(work)(),
  }
  prepare(sql)
  return sql
}
