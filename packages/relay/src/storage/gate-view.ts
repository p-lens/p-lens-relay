import { accessListOf, grantKey, KIND, type GateView, type Grant, type HeldList, type ListedProduct, type Product } from "@p-lens-relay/gate"
import { numberOf, textOf, type Row, type Sql } from "@p-lens-relay/sql"

const heldListOf = (row: Row): readonly HeldList[] => {
  const owner = textOf(row, "pubkey")
  const d = textOf(row, "d")
  const list = accessListOf(textOf(row, "content") ?? "")
  return owner === undefined || d === undefined || list === undefined ? [] : [{ owner, d, list }]
}

const accessList = (sql: Sql, owner: string, product: ListedProduct): HeldList | undefined =>
  sql
    .run("SELECT pubkey, d, json_extract(raw, '$.content') AS content FROM events WHERE kind = ? AND pubkey = ?", KIND.accessList, owner)
    .flatMap(heldListOf)
    .find((held) => held.list.product === product)

const listedBy = (sql: Sql, member: string, role: "editor" | "sender"): readonly HeldList[] =>
  sql
    .run(
      `SELECT events.pubkey AS pubkey, events.d AS d, json_extract(events.raw, '$.content') AS content
       FROM members JOIN events ON events.id = members.event_id
       WHERE members.pubkey = ? AND members.role = ?`,
      member,
      role,
    )
    .flatMap(heldListOf)

const capNow = (sql: Sql, subject: string, product: Product, now: number): number | undefined =>
  numberOf(sql.run("SELECT max(cap) AS cap FROM grants WHERE key = ? AND starts <= ? AND ends > ?", grantKey(subject, product), now, now)[0], "cap")

/** The gate's view of a bucket, as of one moment, over its SQLite. */
export const sqlView = (sql: Sql, now: number): GateView => ({
  capNow: (subject, product) => capNow(sql, subject, product, now),
  isSpent: (ticket) => sql.run("SELECT 1 FROM spent WHERE ticket = ?", ticket).length > 0,
  accessList: (owner, product) => accessList(sql, owner, product),
  listedBy: (member, role) => listedBy(sql, member, role),
  huddleAuthors: (v) =>
    new Set(sql.run("SELECT DISTINCT pubkey FROM events WHERE kind = ? AND v = ?", KIND.huddleState, v).flatMap((row) => textOf(row, "pubkey") ?? [])),
})

/** Keeps a grant and spends its ticket, forgetting grants and tickets that have run out. */
export const keepGrant = (sql: Sql, key: string, grant: Grant, ticket: string, now: number): void =>
  sql.atomically(() => {
    sql.run("DELETE FROM grants WHERE ends <= ?", now)
    sql.run("DELETE FROM spent WHERE ends <= ?", now)
    sql.run("INSERT INTO grants (key, cap, starts, ends) VALUES (?, ?, ?, ?)", key, grant.cap, grant.from, grant.until)
    sql.run("INSERT INTO spent (ticket, ends) VALUES (?, ?)", ticket, grant.until)
  })
