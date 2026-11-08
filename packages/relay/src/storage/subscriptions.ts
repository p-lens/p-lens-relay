import { isFilter, matchesAny, tagValues, type Filter, type NostrEvent } from "@p-lens-relay/core"
import { textOf, type Sql } from "@p-lens-relay/sql"

/** A subscription a socket holds open. */
export type Subscription = { readonly socket: string; readonly id: string; readonly filters: readonly Filter[] }

/** What a socket carries of its subscriptions through hibernation: each by its id. */
export type Carried = readonly { readonly id: string; readonly filters: readonly Filter[] }[]

/**
 * Every open subscription of a bucket, by the lines its filters name, so that
 * an event is matched against the subscriptions of its own line and those
 * naming none.
 */
export type Subscriptions = {
  readonly byLine: ReadonlyMap<string, readonly Subscription[]>
  readonly unlined: readonly Subscription[]
}

const linesOf = (subscription: Subscription): readonly string[] | undefined =>
  subscription.filters.every((filter) => filter["#v"] !== undefined) ? [...new Set(subscription.filters.flatMap((filter) => filter["#v"] ?? []))] : undefined

export const indexed = (all: readonly Subscription[]): Subscriptions => {
  const byLine = new Map<string, readonly Subscription[]>()
  all.forEach((subscription) => linesOf(subscription)?.forEach((line) => byLine.set(line, [...(byLine.get(line) ?? []), subscription])))
  return { byLine, unlined: all.filter((subscription) => linesOf(subscription) === undefined) }
}

const filtersOf = (value: unknown): readonly Filter[] | undefined => (Array.isArray(value) && value.every(isFilter) ? value : undefined)

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null

const entryOf = (value: unknown): Carried[number] | undefined => {
  if (!isRecord(value) || typeof value.id !== "string") return undefined
  const filters = filtersOf(value.filters)
  return filters === undefined ? undefined : { id: value.id, filters }
}

/** A socket's subscriptions from what it carried, leaving out whatever does not read. */
export const carriedOf = (value: unknown): Carried => (Array.isArray(value) ? value.flatMap((entry: unknown) => entryOf(entry) ?? []) : [])

/**
 * The subscriptions of the sockets named that could not carry their own, as
 * a host's attachment is bounded: kept in SQLite until the socket carries them
 * again or goes, so that they outlast hibernation as the others do.
 */
export const readSpilled = (sql: Sql, sockets: readonly string[]): ReadonlyMap<string, Carried> => {
  const spilled = new Map<string, Carried>()
  sql.run("SELECT socket, id, filters FROM subscriptions WHERE socket IN (SELECT value FROM json_each(?))", JSON.stringify(sockets)).forEach((row) => {
    const socket = textOf(row, "socket")
    const entry = entryOf({ id: textOf(row, "id"), filters: JSON.parse(textOf(row, "filters") ?? "null") })
    if (socket !== undefined && entry !== undefined) spilled.set(socket, [...(spilled.get(socket) ?? []), entry])
  })
  return spilled
}

/** Puts a socket's subscriptions in SQLite in place of whatever it spilled before. */
export const spill = (sql: Sql, socket: string, carried: Carried): void => {
  sql.atomically(() => {
    sql.run("DELETE FROM subscriptions WHERE socket = ?", socket)
    carried.forEach((entry) => sql.run("INSERT INTO subscriptions (socket, id, filters) VALUES (?, ?, ?)", socket, entry.id, JSON.stringify(entry.filters)))
  })
}

export const dropSpilled = (sql: Sql, socket: string): void => {
  sql.run("DELETE FROM subscriptions WHERE socket = ?", socket)
}

/** Forgets what sockets no longer open spilled: every one not among those left after a restart. */
export const dropSpilledBut = (sql: Sql, open: readonly string[]): void => {
  sql.run("DELETE FROM subscriptions WHERE socket NOT IN (SELECT value FROM json_each(?))", JSON.stringify(open))
}

/** The subscriptions an event goes to. */
export const deliveriesOf = (subscriptions: Subscriptions, event: NostrEvent): readonly Subscription[] => {
  const line = tagValues(event, "v")[0]
  const candidates = [...(line === undefined ? [] : (subscriptions.byLine.get(line) ?? [])), ...subscriptions.unlined]
  return candidates.filter((subscription) => matchesAny(subscription.filters, event))
}
