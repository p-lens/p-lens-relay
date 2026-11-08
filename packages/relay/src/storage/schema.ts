import { numberOf, type Sql } from "@p-lens-relay/sql"

/**
 * The shape a bucket's tables are in. 2 keeps replaceable and addressable
 * events in `slots`, apart from the rest, so that a new version is one row
 * updated in place rather than a row deleted and another inserted, each
 * touching every index.
 */
const SHAPE = 2

/**
 * A bucket's tables. `v`, `d` and `slot` are kept as PLN-1 shapes events:
 * one `v`, and a `d` on addressable events alone; the gate refuses any other
 * shape before an event is kept.
 *
 * Rows written are billed, and a write is billed a row more for each index
 * whose columns it includes. So `slots` is keyed by the slot, and its
 * indexes hold only what a slot never changes (its author and kind) and its
 * line, which a new version rarely moves: replacing a version in place
 * touches none of them. `events` keeps one index beyond its key, the one
 * every line is read by, and its expiration's.
 */
const TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    pubkey TEXT NOT NULL,
    kind INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    v TEXT,
    d TEXT,
    slot TEXT,
    expiration INTEGER,
    raw TEXT NOT NULL
  ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS events_by_line ON events (v, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS events_by_expiration ON events (expiration) WHERE expiration IS NOT NULL",
  `CREATE TABLE IF NOT EXISTS slots (
    slot TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    kind INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    v TEXT,
    d TEXT,
    expiration INTEGER,
    raw TEXT NOT NULL
  ) WITHOUT ROWID`,
  "CREATE INDEX IF NOT EXISTS slots_by_line ON slots (v) WHERE v IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS slots_by_author ON slots (pubkey, kind)",
  `CREATE TABLE IF NOT EXISTS deleted (
    pubkey TEXT NOT NULL,
    id TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (pubkey, id)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS members (
    event_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    product TEXT NOT NULL,
    d TEXT NOT NULL,
    role TEXT NOT NULL,
    pubkey TEXT,
    mailbox TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS members_by_event ON members (event_id)",
  "CREATE INDEX IF NOT EXISTS members_by_pubkey ON members (pubkey, role)",
  `CREATE TABLE IF NOT EXISTS grants (
    key TEXT NOT NULL,
    cap INTEGER NOT NULL,
    starts INTEGER NOT NULL,
    ends INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS grants_by_key ON grants (key, ends)",
  "CREATE TABLE IF NOT EXISTS spent (ticket TEXT PRIMARY KEY, ends INTEGER NOT NULL) WITHOUT ROWID",
  `CREATE TABLE IF NOT EXISTS subscriptions (
    socket TEXT NOT NULL,
    id TEXT NOT NULL,
    filters TEXT NOT NULL,
    PRIMARY KEY (socket, id)
  ) WITHOUT ROWID`,
  "CREATE TABLE IF NOT EXISTS shape (version INTEGER NOT NULL)",
]

/**
 * What takes a bucket kept in shape 1 to shape 2: its replaceable and
 * addressable events moved into `slots`, and the indexes that moved with
 * them or that no read needs any more dropped.
 */
const TO_SLOTS: readonly string[] = [
  `INSERT OR IGNORE INTO slots (slot, id, pubkey, kind, created_at, v, d, expiration, raw)
    SELECT slot, id, pubkey, kind, created_at, v, d, expiration, raw FROM events WHERE slot IS NOT NULL`,
  "DELETE FROM events WHERE slot IS NOT NULL",
  "DROP INDEX IF EXISTS events_by_slot",
  "DROP INDEX IF EXISTS events_by_author",
  "DROP INDEX IF EXISTS events_by_time",
]

/** Every event a bucket keeps, from both tables, as one table to read from. */
export const KEPT = `(SELECT id, pubkey, kind, created_at, v, d, expiration, raw FROM events
  UNION ALL SELECT id, pubkey, kind, created_at, v, d, expiration, raw FROM slots)`

const shapeOf = (sql: Sql): number => numberOf(sql.run("SELECT max(version) AS version FROM shape")[0], "version") ?? 1

/** Makes whatever tables are missing and brings a bucket kept in an older shape up to this one; run each time a bucket wakes, and it reads one row once a bucket is in shape. */
export const prepare = (sql: Sql): void => {
  sql.atomically(() => {
    TABLES.forEach((statement) => sql.run(statement))
    if (shapeOf(sql) >= SHAPE) return
    TO_SLOTS.forEach((statement) => sql.run(statement))
    sql.run("DELETE FROM shape")
    sql.run("INSERT INTO shape (version) VALUES (?)", SHAPE)
  })
}
