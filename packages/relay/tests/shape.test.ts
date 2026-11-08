import { RULES, type NostrEvent } from "@p-lens-relay/core"
import { signed, writer } from "@p-lens-relay/core/testing"
import { KIND } from "@p-lens-relay/gate"
import { opaque, sealedContent } from "@p-lens-relay/gate/testing"
import { memorySql } from "@p-lens-relay/sql/testing"
import type { Sql } from "@p-lens-relay/sql"
import { describe, expect, test } from "bun:test"
import { admitInto, queryFrom } from "../src/storage/events"
import { prepare } from "../src/storage/schema"

/** The tables a bucket kept before shape 2, as they were made then. */
const SHAPE_ONE: readonly string[] = [
  `CREATE TABLE events (
    id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, kind INTEGER NOT NULL, created_at INTEGER NOT NULL,
    v TEXT, d TEXT, slot TEXT, expiration INTEGER, raw TEXT NOT NULL
  ) WITHOUT ROWID`,
  "CREATE INDEX events_by_line ON events (v, created_at DESC)",
  "CREATE INDEX events_by_author ON events (pubkey, kind, created_at DESC)",
  "CREATE INDEX events_by_time ON events (created_at DESC)",
  "CREATE UNIQUE INDEX events_by_slot ON events (slot) WHERE slot IS NOT NULL",
  "CREATE INDEX events_by_expiration ON events (expiration) WHERE expiration IS NOT NULL",
]

/** An event kept as shape 1 kept it: every event in `events`, a replaceable or addressable one with its slot. */
const keptAsShapeOne = (sql: Sql, event: NostrEvent, slot: string | null, d: string | null): void => {
  sql.run(
    "INSERT INTO events (id, pubkey, kind, created_at, v, d, slot, expiration, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    event.id,
    event.pubkey,
    event.kind,
    event.created_at,
    opaque(1),
    d,
    slot,
    null,
    JSON.stringify(event),
  )
}

const AUTHOR = writer(1)
const TIP = signed(AUTHOR, { kind: KIND.tip, created_at: 1_000, tags: [["v", opaque(1)], ["d", opaque(11)]], content: sealedContent() })
const CHANGE = signed(AUTHOR, { kind: KIND.bookChange, created_at: 1_001, tags: [["v", opaque(1)]], content: sealedContent() })

const shapeOneBucket = (): Sql =>
  memorySql((sql) => {
    SHAPE_ONE.forEach((statement) => sql.run(statement))
    keptAsShapeOne(sql, TIP, `${KIND.tip}:${AUTHOR.pubkey}:${opaque(11)}`, opaque(11))
    keptAsShapeOne(sql, CHANGE, null, null)
  })

const indexes = (sql: Sql): readonly string[] =>
  sql.run("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((row) => String(row.name))

describe("a bucket kept in shape 1", () => {
  test("moves its replaceable and addressable events into slots as it wakes, and finds the same events", () => {
    const sql = shapeOneBucket()
    prepare(sql)
    expect(sql.run("SELECT id FROM slots").map((row) => row.id)).toEqual([TIP.id])
    expect(sql.run("SELECT id FROM events").map((row) => row.id)).toEqual([CHANGE.id])
    expect(queryFrom(sql, [{ "#v": [opaque(1)] }], RULES, 1_000).map((event) => event.id)).toEqual([CHANGE.id, TIP.id])
  })

  test("drops the indexes no read needs any more", () => {
    const sql = shapeOneBucket()
    prepare(sql)
    expect(indexes(sql)).toEqual(["events_by_expiration", "events_by_line"])
  })

  test("is moved once: waking again moves nothing and keeps one shape", () => {
    const sql = shapeOneBucket()
    prepare(sql)
    prepare(sql)
    expect(sql.run("SELECT count(*) AS n FROM slots")[0]?.n).toBe(1)
    expect(sql.run("SELECT version FROM shape").map((row) => row.version)).toEqual([2])
  })

  test("takes a new version of a moved slot in place of the old", () => {
    const sql = shapeOneBucket()
    prepare(sql)
    const newer = signed(AUTHOR, { kind: KIND.tip, created_at: 1_005, tags: [["v", opaque(1)], ["d", opaque(11)]], content: sealedContent(64) })
    expect(admitInto(sql, RULES.tie, newer)).toEqual({ type: "stored", replaced: TIP })
    expect(sql.run("SELECT id FROM slots").map((row) => row.id)).toEqual([newer.id])
  })
})

describe("a new version of a slot", () => {
  test("follows its line where it moved to another", () => {
    const sql = memorySql(prepare)
    admitInto(sql, RULES.tie, TIP)
    const moved = signed(AUTHOR, { kind: KIND.tip, created_at: 1_005, tags: [["v", opaque(2)], ["d", opaque(11)]], content: sealedContent() })
    admitInto(sql, RULES.tie, moved)
    expect(queryFrom(sql, [{ "#v": [opaque(1)] }], RULES, 1_000)).toEqual([])
    expect(queryFrom(sql, [{ "#v": [opaque(2)] }], RULES, 1_000).map((event) => event.id)).toEqual([moved.id])
  })
})
