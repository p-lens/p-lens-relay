import { answerOf, readClientMessage, refusalBeforeKeeping, tagValues, type Filter, type NostrEvent, type RelayMessage } from "@p-lens-relay/core"
import { judge, KIND, reasonOf, type TicketReader, type TicketReading } from "@p-lens-relay/gate"
import type { Settings } from "./settings"
import { ticketReaderOf } from "./ticket-reader"
import { admitInto, dueOfKept, queryFrom } from "./storage/events"
import { keepGrant, sqlView } from "./storage/gate-view"
import type { Sql } from "@p-lens-relay/sql"
import {
  carriedOf,
  deliveriesOf,
  dropSpilled,
  dropSpilledBut,
  indexed,
  readSpilled,
  spill,
  type Carried,
  type Subscriptions,
} from "./storage/subscriptions"
import { prepare } from "./storage/schema"

/** What a bucket sends: to a socket by its id. */
export type Outgoing = { readonly to: string; readonly message: RelayMessage }

/**
 * What a host does for a bucket: has a socket carry its subscriptions through
 * hibernation, false when they do not fit and are kept in SQLite instead, and
 * hears when something kept runs out, so that a pruning is set for then if
 * none sooner is.
 */
export type Holding = {
  readonly carry: (socket: string, carried: Carried) => boolean
  readonly due: (at: number) => void
}

/** A host that keeps nothing through hibernation, its process holding every socket, and prunes on a timer of its own. */
export const HELD_IN_PROCESS: Holding = { carry: () => true, due: () => undefined }

/**
 * A bucket as its sessions see it: its SQLite, how it is set, how tickets are
 * read, its host, and its open sockets' subscriptions, kept in memory and
 * carried by the sockets rather than written each time one opens or closes;
 * those of the sockets that could not carry them are spilled to SQLite. The
 * subscriptions by line are worked out again whenever one changes.
 */
export type Bucket = {
  readonly sql: Sql
  readonly settings: Settings
  readonly readTicket: TicketReader
  readonly holding: Holding
  readonly held: { sockets: ReadonlyMap<string, Carried>; spilled: ReadonlySet<string>; subscriptions: Subscriptions | undefined }
}

/** A bucket over its SQLite, as a deployment is set, its tickets read by the issuer's key, a key that cannot be read said by `warn`. */
export const bucketOf = (sql: Sql, settings: Settings, holding: Holding, warn: (text: string) => void): Bucket => ({
  sql,
  settings,
  readTicket: ticketReaderOf(settings.issuer?.key, warn),
  holding,
  held: { sockets: new Map(), spilled: new Set(), subscriptions: undefined },
})

const ok = (to: string, id: string, [accepted, reason]: readonly [boolean, string]): Outgoing => ({ to, message: ["OK", id, accepted, reason] })

const subscriptionsOf = (bucket: Bucket): Subscriptions => {
  if (bucket.held.subscriptions === undefined)
    bucket.held.subscriptions = indexed([...bucket.held.sockets].flatMap(([socket, carried]) => carried.map((entry) => ({ socket, ...entry }))))
  return bucket.held.subscriptions
}

const without = <T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> => new Set([...set].filter((kept) => kept !== value))

/** Holds a socket to the subscriptions it has now, carried by it or, when they do not fit, spilled. */
const hold = (bucket: Bucket, socket: string, carried: Carried): void => {
  bucket.held.sockets = new Map([...bucket.held.sockets].filter(([kept]) => kept !== socket).concat(carried.length === 0 ? [] : [[socket, carried]]))
  bucket.held.subscriptions = undefined
  if (!bucket.holding.carry(socket, carried)) {
    spill(bucket.sql, socket, carried)
    bucket.held.spilled = new Set([...bucket.held.spilled, socket])
  } else if (bucket.held.spilled.has(socket)) {
    dropSpilled(bucket.sql, socket)
    bucket.held.spilled = without(bucket.held.spilled, socket)
  }
}

const carriedBy = (bucket: Bucket, socket: string): Carried => bucket.held.sockets.get(socket) ?? []

const deliveries = (bucket: Bucket, event: NostrEvent): readonly Outgoing[] =>
  deliveriesOf(subscriptionsOf(bucket), event).map((subscription) => ({ to: subscription.socket, message: ["EVENT", subscription.id, event] }))

const ticketOf = (bucket: Bucket, event: NostrEvent): Promise<TicketReading | undefined> => {
  const claim = event.kind === KIND.redemption ? tagValues(event, "claim")[0] : undefined
  return claim === undefined ? Promise.resolve(undefined) : bucket.readTicket(claim)
}

const onEvent = async (bucket: Bucket, from: string, event: NostrEvent, size: number, now: number): Promise<readonly Outgoing[]> => {
  const refusal = refusalBeforeKeeping(bucket.settings.rules, event, size, now)
  if (refusal !== undefined) return [ok(from, event.id, [false, refusal])]
  const verdict = judge(bucket.settings.gate, sqlView(bucket.sql, now), event, await ticketOf(bucket, event), now)
  switch (verdict.type) {
    case "refuse":
      return [ok(from, event.id, [false, reasonOf(verdict.refusal)])]
    case "redeem":
      keepGrant(bucket.sql, verdict.key, verdict.grant, verdict.ticket, now)
      return [ok(from, event.id, [true, ""])]
    case "accept": {
      const admission = admitInto(bucket.sql, bucket.settings.rules.tie, event)
      const delivered = admission.type === "stored" || admission.type === "passed" ? deliveries(bucket, event) : []
      const due = admission.type === "stored" ? dueOfKept(event) : undefined
      if (due !== undefined) bucket.holding.due(due)
      return [ok(from, event.id, answerOf(admission)), ...delivered]
    }
  }
}

const closedWith = (to: string, id: string, reason: string): readonly Outgoing[] => [{ to, message: ["CLOSED", id, reason] }]

const onReq = (bucket: Bucket, from: string, id: string, filters: readonly Filter[], now: number): readonly Outgoing[] => {
  if (filters.length > bucket.settings.mostFilters) return closedWith(from, id, "restricted: too many filters")
  const others = carriedBy(bucket, from).filter((entry) => entry.id !== id)
  if (others.length >= bucket.settings.mostSubscriptions) return closedWith(from, id, "restricted: too many subscriptions")
  const found = queryFrom(bucket.sql, filters, bucket.settings.rules, now)
  hold(bucket, from, [...others, { id, filters }])
  return [...found.map((event): Outgoing => ({ to: from, message: ["EVENT", id, event] })), { to: from, message: ["EOSE", id] }]
}

/**
 * One message from a socket: what the bucket sends because of it, to that
 * socket and any other. A ticket is read before anything else, since reading
 * it waits; after that, the gate's judgement and the keeping it allows run
 * with no wait between them, so that no other message is taken in between and
 * a cap cannot be passed by two writes judged at once.
 */
export const receive = async (bucket: Bucket, from: string, raw: string, now: number): Promise<readonly Outgoing[]> => {
  const message = readClientMessage(raw)
  switch (message.type) {
    case "event":
      return onEvent(bucket, from, message.event, message.size, now)
    case "invalid-event":
      return [ok(from, message.id, [false, `invalid: ${message.invalidity.type}`])]
    case "req":
      return onReq(bucket, from, message.id, message.filters, now)
    case "bad-filter":
      return closedWith(from, message.id, "invalid: filter")
    case "close": {
      const carried = carriedBy(bucket, from)
      if (carried.some((entry) => entry.id === message.id)) hold(bucket, from, carried.filter((entry) => entry.id !== message.id))
      return []
    }
    case "unreadable":
      return [{ to: from, message: ["NOTICE", message.notice] }]
  }
}

/** A socket has gone: its subscriptions go with it. */
export const leave = (bucket: Bucket, socket: string): void => {
  bucket.held.sockets = new Map([...bucket.held.sockets].filter(([kept]) => kept !== socket))
  bucket.held.subscriptions = undefined
  if (!bucket.held.spilled.has(socket)) return
  dropSpilled(bucket.sql, socket)
  bucket.held.spilled = without(bucket.held.spilled, socket)
}

/** A socket still open as a bucket wakes, with what it carried. */
export type Waking = { readonly socket: string; readonly carried: unknown }

/**
 * A bucket has woken: its tables are made if missing, each open socket is
 * held to what it carried or spilled, and what sockets that went while it
 * slept spilled is forgotten.
 */
export const wake = (bucket: Bucket, open: readonly Waking[]): void => {
  prepare(bucket.sql)
  const sockets = open.map((waking) => waking.socket)
  dropSpilledBut(bucket.sql, sockets)
  const spilled = readSpilled(bucket.sql, sockets)
  bucket.held.sockets = new Map(open.flatMap((waking): (readonly [string, Carried])[] => {
    const carried = spilled.get(waking.socket) ?? carriedOf(waking.carried)
    return carried.length === 0 ? [] : [[waking.socket, carried]]
  }))
  bucket.held.spilled = new Set(spilled.keys())
  bucket.held.subscriptions = undefined
}
