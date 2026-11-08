import type { NostrEvent } from "./event"
import { matchesAny, type Filter } from "./filter"
import { answerOf, readClientMessage, refusalBeforeKeeping, type RelayMessage } from "./message"
import type { Rules } from "./rules"
import { admit, emptyStore, query, type Store } from "./store"

export type ConnectionId = string

export type Outgoing = { readonly to: ConnectionId; readonly message: RelayMessage }

/** A relay held in memory: its events, each connection's subscriptions, and when each connection sent. */
export type RelayState = {
  readonly store: Store
  readonly subscriptions: ReadonlyMap<ConnectionId, ReadonlyMap<string, readonly Filter[]>>
  readonly sent: ReadonlyMap<ConnectionId, readonly number[]>
}

type Step = { readonly state: RelayState; readonly outgoing: readonly Outgoing[] }

export const emptyRelay: RelayState = { store: emptyStore, subscriptions: new Map(), sent: new Map() }

const ok = (to: ConnectionId, id: string, [accepted, reason]: readonly [boolean, string]): Outgoing => ({
  to,
  message: ["OK", id, accepted, reason],
})

const deliveries = (state: RelayState, event: NostrEvent): readonly Outgoing[] =>
  [...state.subscriptions].flatMap(([to, subscriptions]) =>
    [...subscriptions].flatMap(([id, filters]) => (matchesAny(filters, event) ? [{ to, message: ["EVENT", id, event] as const }] : [])),
  )

const recentSends = (state: RelayState, from: ConnectionId, now: number): readonly number[] =>
  (state.sent.get(from) ?? []).filter((at) => at > now - 60)

const withSend = (state: RelayState, from: ConnectionId, now: number): RelayState => ({
  ...state,
  sent: new Map(state.sent).set(from, [...recentSends(state, from, now), now]),
})

const onEvent = (rules: Rules, state: RelayState, from: ConnectionId, event: NostrEvent, size: number, now: number): Step => {
  const refusal = refusalBeforeKeeping(rules, event, size, now)
  if (refusal !== undefined) return { state, outgoing: [ok(from, event.id, [false, refusal])] }
  if (rules.perMinute !== undefined && recentSends(state, from, now).length >= rules.perMinute) {
    return { state, outgoing: [ok(from, event.id, [false, "rate-limited: slow down"])] }
  }
  const counted = withSend(state, from, now)
  const { store, admission } = admit(rules.tie, counted.store, event)
  const next = { ...counted, store }
  const delivered = admission.type === "stored" || admission.type === "passed" ? deliveries(next, event) : []
  return { state: next, outgoing: [ok(from, event.id, answerOf(admission)), ...delivered] }
}

const withSubscription = (state: RelayState, from: ConnectionId, id: string, filters: readonly Filter[] | undefined): RelayState => {
  const held = new Map(state.subscriptions.get(from) ?? [])
  if (filters === undefined) held.delete(id)
  else held.set(id, filters)
  return { ...state, subscriptions: new Map(state.subscriptions).set(from, held) }
}

/** One message from a connection: the relay as it stands after, and what it sends. */
export const step = (rules: Rules, state: RelayState, from: ConnectionId, raw: string, now: number): Step => {
  const message = readClientMessage(raw)
  switch (message.type) {
    case "event":
      return onEvent(rules, state, from, message.event, message.size, now)
    case "invalid-event":
      return { state, outgoing: [ok(from, message.id, [false, `invalid: ${message.invalidity.type}`])] }
    case "req": {
      const found = query(state.store, message.filters, rules.defaultLimit, rules.maxLimit, now)
      return {
        state: withSubscription(state, from, message.id, message.filters),
        outgoing: [...found.map((event): Outgoing => ({ to: from, message: ["EVENT", message.id, event] })), { to: from, message: ["EOSE", message.id] }],
      }
    }
    case "bad-filter":
      return { state, outgoing: [{ to: from, message: ["CLOSED", message.id, "invalid: filter"] }] }
    case "close":
      return { state: withSubscription(state, from, message.id, undefined), outgoing: [] }
    case "unreadable":
      return { state, outgoing: [{ to: from, message: ["NOTICE", message.notice] }] }
  }
}

/** Forgets a connection that has gone. */
export const disconnect = (state: RelayState, connection: ConnectionId): RelayState => {
  const subscriptions = new Map(state.subscriptions)
  const sent = new Map(state.sent)
  subscriptions.delete(connection)
  sent.delete(connection)
  return { ...state, subscriptions, sent }
}
