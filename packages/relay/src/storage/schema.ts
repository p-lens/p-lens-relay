import type { Sql } from "@p-lens-relay/sql"

/**
 * A bucket's tables. `v`, `d` and `slot` are kept as PLN-1 shapes events:
 * one `v`, and a `d` on addressable events alone; the gate refuses any other
 * shape before an event is kept.
 */
const STATEMENTS: readonly string[] = [
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
  "CREATE INDEX IF NOT EXISTS events_by_author ON events (pubkey, kind, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS events_by_time ON events (created_at DESC)",
  "CREATE UNIQUE INDEX IF NOT EXISTS events_by_slot ON events (slot) WHERE slot IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS events_by_expiration ON events (expiration) WHERE expiration IS NOT NULL",
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
]

/** Makes whatever tables are missing; run each time a bucket wakes. */
export const prepare = (sql: Sql): void => {
  sql.atomically(() => STATEMENTS.forEach((statement) => sql.run(statement)))
}
