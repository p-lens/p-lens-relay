import {
  dOf,
  expirationOf,
  joined,
  kindClass,
  matches,
  replaces,
  slotOf,
  tagValues,
  takenOf,
  type Admission,
  type Filter,
  type NostrEvent,
  type Rules,
  type Tie,
} from "@p-lens-relay/core"
import { accessListOf, KIND } from "@p-lens-relay/gate"
import { listParam, numberOf, textOf, type Row, type Sql, type SqlValue } from "@p-lens-relay/sql"
import { KEPT } from "./schema"

/** The most rows one filter reads when it names a tag no column holds, and is matched after reading. */
const MOST_SCANNED = 5_000

const eventOf = (raw: string | undefined): NostrEvent | undefined => (raw === undefined ? undefined : (JSON.parse(raw) as NostrEvent))

const keepMembers = (sql: Sql, event: NostrEvent): void => {
  const list = event.kind === KIND.accessList ? accessListOf(event.content) : undefined
  list?.members.forEach((member) =>
    sql.run(
      "INSERT INTO members (event_id, owner, product, d, role, pubkey, mailbox) VALUES (?, ?, ?, ?, ?, ?, ?)",
      event.id,
      event.pubkey,
      list.product,
      dOf(event),
      member.role,
      member.role === "viewer" ? null : member.pubkey,
      member.mailbox,
    ),
  )
}

const insert = (sql: Sql, event: NostrEvent): void => {
  sql.run(
    "INSERT INTO events (id, pubkey, kind, created_at, v, d, slot, expiration, raw) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
    event.id,
    event.pubkey,
    event.kind,
    event.created_at,
    lineOf(event),
    null,
    expirationOf(event) ?? null,
    JSON.stringify(event),
  )
  keepMembers(sql, event)
}

const lineOf = (event: NostrEvent): string | null => tagValues(event, "v")[0] ?? null

const addressOf = (event: NostrEvent): string | null => (kindClass(event.kind) === "addressable" ? dOf(event) : null)

/** Keeps the first version of a slot. */
const insertSlot = (sql: Sql, slot: string, event: NostrEvent): void => {
  sql.run(
    "INSERT INTO slots (slot, id, pubkey, kind, created_at, v, d, expiration, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    slot,
    event.id,
    event.pubkey,
    event.kind,
    event.created_at,
    lineOf(event),
    addressOf(event),
    expirationOf(event) ?? null,
    JSON.stringify(event),
  )
  keepMembers(sql, event)
}

/**
 * Puts a new version of a slot in place of the one held, as one row updated:
 * its author, kind and address are the slot's own, so only what changes is
 * set, and its line only where the new version moved it, so that no index
 * is written to.
 */
const replaceSlot = (sql: Sql, slot: string, held: NostrEvent, event: NostrEvent): void => {
  const line = lineOf(event)
  const moved = line !== lineOf(held)
  sql.run(
    `UPDATE slots SET id = ?, created_at = ?, expiration = ?, raw = ?${moved ? ", v = ?" : ""} WHERE slot = ?`,
    event.id,
    event.created_at,
    expirationOf(event) ?? null,
    JSON.stringify(event),
    ...(moved ? [line] : []),
    slot,
  )
  sql.run("DELETE FROM members WHERE event_id = ?", held.id)
  keepMembers(sql, event)
}

const isHeld = (sql: Sql, id: string): boolean => sql.run("SELECT 1 FROM events WHERE id = ?", id).length > 0

const isDeleted = (sql: Sql, event: NostrEvent): boolean =>
  sql.run("SELECT 1 FROM deleted WHERE pubkey = ? AND id = ?", event.pubkey, event.id).length > 0

const keepDeletion = (sql: Sql, deletion: NostrEvent): void => {
  tagValues(deletion, "e").forEach((target) => {
    sql.run(`DELETE FROM members WHERE event_id IN (SELECT id FROM ${KEPT} WHERE id = ? AND pubkey = ?)`, target, deletion.pubkey)
    sql.run("DELETE FROM events WHERE id = ? AND pubkey = ?", target, deletion.pubkey)
    sql.run("DELETE FROM slots WHERE id = ? AND pubkey = ?", target, deletion.pubkey)
    sql.run("INSERT OR IGNORE INTO deleted (pubkey, id, at) VALUES (?, ?, ?)", deletion.pubkey, target, deletion.created_at)
  })
  insert(sql, deletion)
}

const slotted = (sql: Sql, tie: Tie, slot: string, event: NostrEvent): Admission => {
  const held = eventOf(textOf(sql.run("SELECT raw FROM slots WHERE slot = ?", slot)[0], "raw"))
  if (held?.id === event.id) return { type: "duplicate" }
  if (isDeleted(sql, event)) return { type: "deleted" }
  if (held === undefined) {
    insertSlot(sql, slot, event)
    return { type: "stored", replaced: undefined }
  }
  if (!replaces(tie, event, held)) return { type: "have-newer" }
  replaceSlot(sql, slot, held, event)
  return { type: "stored", replaced: held }
}

/** Takes an event in as the relay core does in memory (`admit`), over SQLite. */
export const admitInto = (sql: Sql, tie: Tie, event: NostrEvent): Admission =>
  sql.atomically((): Admission => {
    const slot = kindClass(event.kind) === "ephemeral" ? undefined : slotOf(event)
    if (slot !== undefined) return slotted(sql, tie, slot, event)
    if (isHeld(sql, event.id)) return { type: "duplicate" }
    if (isDeleted(sql, event)) return { type: "deleted" }
    if (kindClass(event.kind) === "ephemeral") return { type: "passed" }
    if (event.kind === KIND.deletion) {
      keepDeletion(sql, event)
      return { type: "stored", replaced: undefined }
    }
    insert(sql, event)
    return { type: "stored", replaced: undefined }
  })

type Clause = { readonly where: string; readonly params: readonly SqlValue[] }

const listed = (column: string, values: readonly (string | number)[] | undefined): readonly Clause[] =>
  values === undefined ? [] : [{ where: `${column} IN (SELECT value FROM json_each(?))`, params: [listParam(values)] }]

const bound = (where: string, value: number | undefined): readonly Clause[] => (value === undefined ? [] : [{ where, params: [value] }])

/** The tags a filter names that no column holds, which are matched once the rows are read. */
const unindexedTags = (filter: Filter): readonly string[] =>
  Object.keys(filter).filter((key) => key.startsWith("#") && key !== "#v" && key !== "#d")

const clausesOf = (filter: Filter, now: number): readonly Clause[] => [
  { where: "(expiration IS NULL OR expiration > ?)", params: [now] },
  ...listed("id", filter.ids),
  ...listed("pubkey", filter.authors),
  ...listed("kind", filter.kinds),
  ...listed("v", filter["#v"]),
  ...listed("d", filter["#d"]),
  ...bound("created_at >= ?", filter.since),
  ...bound("created_at <= ?", filter.until),
]

const found = (sql: Sql, filter: Filter, rules: Rules, now: number): readonly NostrEvent[] => {
  const clauses = clausesOf(filter, now)
  const taken = takenOf(filter, rules.defaultLimit, rules.maxLimit)
  const exact = unindexedTags(filter).length === 0
  const limit = exact && taken !== "oldest-all" ? taken : MOST_SCANNED
  const rows = sql.run(
    `SELECT raw FROM ${KEPT} WHERE ${clauses.map((clause) => clause.where).join(" AND ")} ORDER BY created_at DESC, id ASC LIMIT ?`,
    ...clauses.flatMap((clause) => clause.params),
    limit,
  )
  const events = rows.flatMap((row) => eventOf(textOf(row, "raw")) ?? []).filter((event) => matches(filter, event))
  if (taken === "oldest-all") return [...events].reverse()
  return events.slice(0, taken)
}

/** What filters find, as the relay core finds it in memory (`query`), over SQLite. */
export const queryFrom = (sql: Sql, filters: readonly Filter[], rules: Rules, now: number): readonly NostrEvent[] =>
  joined(filters.map((filter) => found(sql, filter, rules, now)))

/** How long a deletion is remembered, so that what it deleted is refused if sent again. */
const DELETIONS_KEPT_SECONDS = 400 * 86_400

/** Takes out what has run out, and forgets old deletions; how many events went. */
export const prune = (sql: Sql, now: number): number =>
  sql.atomically(() => {
    const expired = sql.run("SELECT id FROM events WHERE expiration IS NOT NULL AND expiration <= ?", now).flatMap((row) => textOf(row, "id") ?? [])
    const lapsed = sql.run("SELECT slot, id FROM slots WHERE expiration IS NOT NULL AND expiration <= ?", now)
    expired.forEach((id) => {
      sql.run("DELETE FROM members WHERE event_id = ?", id)
      sql.run("DELETE FROM events WHERE id = ?", id)
    })
    lapsed.forEach((row) => {
      sql.run("DELETE FROM members WHERE event_id = ?", textOf(row, "id") ?? "")
      sql.run("DELETE FROM slots WHERE slot = ?", textOf(row, "slot") ?? "")
    })
    sql.run("DELETE FROM deleted WHERE at < ?", now - DELETIONS_KEPT_SECONDS)
    return expired.length + lapsed.length
  })

const numberIn = (rows: readonly Row[]): number | undefined => numberOf(rows[0], "at")

/** When `prune` next has something to take out: the soonest expiration kept, or the oldest deletion's last day; none when nothing will run out. */
export const dueOf = (sql: Sql): number | undefined => {
  const expiring = numberIn(sql.run(`SELECT min(expiration) AS at FROM ${KEPT} WHERE expiration IS NOT NULL`))
  const forgotten = numberIn(sql.run("SELECT min(at) AS at FROM deleted"))
  const dues = [expiring, forgotten === undefined ? undefined : forgotten + DELETIONS_KEPT_SECONDS + 1].flatMap((at) => at ?? [])
  return dues.length === 0 ? undefined : Math.min(...dues)
}

/** When something an event just kept brings `prune` due: its expiration, and for a deletion the last day it is remembered. */
export const dueOfKept = (event: NostrEvent): number | undefined => {
  const dues = [expirationOf(event), event.kind === KIND.deletion ? event.created_at + DELETIONS_KEPT_SECONDS + 1 : undefined].flatMap((at) => at ?? [])
  return dues.length === 0 ? undefined : Math.min(...dues)
}

