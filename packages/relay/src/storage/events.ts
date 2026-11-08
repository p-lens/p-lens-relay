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
  const addressable = kindClass(event.kind) === "addressable"
  sql.run(
    "INSERT INTO events (id, pubkey, kind, created_at, v, d, slot, expiration, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    event.id,
    event.pubkey,
    event.kind,
    event.created_at,
    tagValues(event, "v")[0] ?? null,
    addressable ? dOf(event) : null,
    slotOf(event) ?? null,
    expirationOf(event) ?? null,
    JSON.stringify(event),
  )
  keepMembers(sql, event)
}

/** Takes an event out, and whatever was kept beside it; every way an event leaves goes through here. */
const remove = (sql: Sql, id: string): void => {
  sql.run("DELETE FROM members WHERE event_id = ?", id)
  sql.run("DELETE FROM events WHERE id = ?", id)
}

const isHeld = (sql: Sql, id: string): boolean => sql.run("SELECT 1 FROM events WHERE id = ?", id).length > 0

const isDeleted = (sql: Sql, event: NostrEvent): boolean =>
  sql.run("SELECT 1 FROM deleted WHERE pubkey = ? AND id = ?", event.pubkey, event.id).length > 0

const keepDeletion = (sql: Sql, deletion: NostrEvent): void => {
  tagValues(deletion, "e").forEach((target) => {
    sql.run("DELETE FROM members WHERE event_id IN (SELECT id FROM events WHERE id = ? AND pubkey = ?)", target, deletion.pubkey)
    sql.run("DELETE FROM events WHERE id = ? AND pubkey = ?", target, deletion.pubkey)
    sql.run("INSERT OR IGNORE INTO deleted (pubkey, id, at) VALUES (?, ?, ?)", deletion.pubkey, target, deletion.created_at)
  })
  insert(sql, deletion)
}

/** Takes an event in as the relay core does in memory (`admit`), over SQLite. */
export const admitInto = (sql: Sql, tie: Tie, event: NostrEvent): Admission =>
  sql.atomically((): Admission => {
    if (isHeld(sql, event.id)) return { type: "duplicate" }
    if (isDeleted(sql, event)) return { type: "deleted" }
    if (kindClass(event.kind) === "ephemeral") return { type: "passed" }
    if (event.kind === KIND.deletion) {
      keepDeletion(sql, event)
      return { type: "stored", replaced: undefined }
    }
    const slot = slotOf(event)
    const held = slot === undefined ? undefined : eventOf(textOf(sql.run("SELECT raw FROM events WHERE slot = ?", slot)[0], "raw"))
    if (held !== undefined && !replaces(tie, event, held)) return { type: "have-newer" }
    if (held !== undefined) remove(sql, held.id)
    insert(sql, event)
    return { type: "stored", replaced: held }
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
    `SELECT raw FROM events WHERE ${clauses.map((clause) => clause.where).join(" AND ")} ORDER BY created_at DESC, id ASC LIMIT ?`,
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
    const expired = sql.run("SELECT id FROM events WHERE expiration IS NOT NULL AND expiration <= ?", now)
    expired.forEach((row) => remove(sql, textOf(row, "id") ?? ""))
    sql.run("DELETE FROM deleted WHERE at < ?", now - DELETIONS_KEPT_SECONDS)
    return expired.length
  })

const numberIn = (rows: readonly Row[]): number | undefined => numberOf(rows[0], "at")

/** When `prune` next has something to take out: the soonest expiration kept, or the oldest deletion's last day; none when nothing will run out. */
export const dueOf = (sql: Sql): number | undefined => {
  const expiring = numberIn(sql.run("SELECT min(expiration) AS at FROM events WHERE expiration IS NOT NULL"))
  const forgotten = numberIn(sql.run("SELECT min(at) AS at FROM deleted"))
  const dues = [expiring, forgotten === undefined ? undefined : forgotten + DELETIONS_KEPT_SECONDS + 1].flatMap((at) => at ?? [])
  return dues.length === 0 ? undefined : Math.min(...dues)
}

/** When something an event just kept brings `prune` due: its expiration, and for a deletion the last day it is remembered. */
export const dueOfKept = (event: NostrEvent): number | undefined => {
  const dues = [expirationOf(event), event.kind === KIND.deletion ? event.created_at + DELETIONS_KEPT_SECONDS + 1 : undefined].flatMap((at) => at ?? [])
  return dues.length === 0 ? undefined : Math.min(...dues)
}

