import {
  dOf,
  emptyRelay,
  invalidityOf,
  kindClass,
  step,
  type ConnectionId,
  type NostrEvent,
  type Outgoing,
  type RelayState,
} from "@p-lens-relay/core"
import { draw, drawMany, type Draws } from "./random"
import type { Quirks } from "./quirks"

type Cached = { readonly at: number; readonly events: readonly NostrEvent[] }

export type FakeState = {
  readonly relay: RelayState
  readonly draws: Draws
  readonly cache: ReadonlyMap<string, Cached>
  /** Versions of addressable events since replaced, oldest first. */
  readonly superseded: readonly NostrEvent[]
}

export type FakeStep = { readonly state: FakeState; readonly outgoing: readonly Outgoing[] }

export const emptyFake = (quirks: Quirks): FakeState => ({ relay: emptyRelay, draws: { seed: quirks.seed }, cache: new Map(), superseded: [] })

const parsed = (raw: string): readonly unknown[] | undefined => {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

const slot = (event: NostrEvent): string => `${event.kind}:${event.pubkey}:${dOf(event)}`

const isOk = (out: Outgoing): boolean => out.message[0] === "OK"

const isDeliveryOf = (out: Outgoing, event: NostrEvent): boolean => out.message[0] === "EVENT" && out.message[2].id === event.id

const withoutOk = (quirks: Quirks, outgoing: readonly Outgoing[]): readonly Outgoing[] =>
  quirks.withholdsOk ? outgoing.filter((out) => !isOk(out)) : outgoing

const onEvent = (quirks: Quirks, state: FakeState, from: ConnectionId, raw: string, value: unknown, now: number): FakeStep => {
  const [roll, draws] = draw(state.draws)
  const drawn = { ...state, draws }
  if (invalidityOf(value) === undefined && roll < quirks.drops) {
    const event = value as NostrEvent
    return { state: drawn, outgoing: withoutOk(quirks, [{ to: from, message: ["OK", event.id, true, ""] }]) }
  }
  const next = step(quirks.rules, drawn.relay, from, raw, now)
  const event = value as NostrEvent
  const replaced = event.kind === 5 ? [] : drawn.relay.store.events.filter((held) => !next.state.store.events.includes(held))
  const silenced =
    quirks.dropsEphemeral && invalidityOf(value) === undefined && kindClass(event.kind) === "ephemeral"
      ? next.outgoing.filter((out) => !isDeliveryOf(out, event))
      : next.outgoing
  return { state: { ...drawn, relay: next.state, superseded: [...drawn.superseded, ...replaced] }, outgoing: withoutOk(quirks, silenced) }
}

const fromCache = (quirks: Quirks, state: FakeState, key: string, found: readonly NostrEvent[], now: number): readonly [readonly NostrEvent[], FakeState] => {
  if (quirks.staleCacheSeconds === 0) return [found, state]
  const cached = state.cache.get(key)
  if (cached !== undefined && now - cached.at < quirks.staleCacheSeconds) return [cached.events, state]
  return [found, { ...state, cache: new Map(state.cache).set(key, { at: now, events: found }) }]
}

const olderVersion = (state: FakeState, event: NostrEvent): NostrEvent | undefined =>
  state.superseded.filter((old) => slot(old) === slot(event)).at(-1)

const withOldVersions = (quirks: Quirks, state: FakeState, events: readonly NostrEvent[]): readonly [readonly NostrEvent[], FakeState] => {
  const [rolls, draws] = drawMany(state.draws, events.length)
  const given = events.map((event, index) =>
    kindClass(event.kind) === "addressable" && (rolls[index] ?? 1) < quirks.oldVersions ? (olderVersion(state, event) ?? event) : event,
  )
  return [given, { ...state, draws }]
}

const reordered = (quirks: Quirks, state: FakeState, events: readonly NostrEvent[]): readonly [readonly NostrEvent[], FakeState] => {
  if (!quirks.reorders) return [events, state]
  const [rolls, draws] = drawMany(state.draws, events.length)
  const shuffled = events.map((event, index) => ({ event, key: rolls[index] ?? 0 })).sort((a, b) => a.key - b.key)
  return [shuffled.map(({ event }) => event), { ...state, draws }]
}

const repeated = (quirks: Quirks, state: FakeState, events: readonly NostrEvent[]): readonly [readonly NostrEvent[], FakeState] => {
  const [rolls, draws] = drawMany(state.draws, events.length)
  return [events.flatMap((event, index) => ((rolls[index] ?? 1) < quirks.repeats ? [event, event] : [event])), { ...state, draws }]
}

const isStoredFor = (out: Outgoing, from: ConnectionId, id: string): boolean =>
  out.to === from && out.message[0] === "EVENT" && out.message[1] === id

const onReq = (quirks: Quirks, state: FakeState, from: ConnectionId, raw: string, message: readonly unknown[], now: number): FakeStep => {
  const next = step(quirks.rules, state.relay, from, raw, now)
  const id = message[1]
  if (typeof id !== "string") return { state: { ...state, relay: next.state }, outgoing: next.outgoing }
  const found = next.outgoing.flatMap((out) => (isStoredFor(out, from, id) && out.message[0] === "EVENT" ? [out.message[2]] : []))
  const rest = next.outgoing.filter((out) => !isStoredFor(out, from, id))
  const start = { ...state, relay: next.state }
  const [cached, afterCache] = fromCache(quirks, start, JSON.stringify(message.slice(2)), found, now)
  const [aged, afterAge] = withOldVersions(quirks, afterCache, cached)
  const [shuffled, afterShuffle] = reordered(quirks, afterAge, aged)
  const [given, afterRepeat] = repeated(quirks, afterShuffle, shuffled)
  const stored = given.map((event): Outgoing => ({ to: from, message: ["EVENT", id, event] }))
  return { state: afterRepeat, outgoing: [...stored, ...rest] }
}

/** One message to a relay that misbehaves as the quirks say. */
export const fakeStep = (quirks: Quirks, state: FakeState, from: ConnectionId, raw: string, now: number): FakeStep => {
  const message = parsed(raw)
  switch (message?.[0]) {
    case "EVENT":
      return onEvent(quirks, state, from, raw, message[1], now)
    case "REQ":
      return onReq(quirks, state, from, raw, message, now)
    default: {
      const next = step(quirks.rules, state.relay, from, raw, now)
      return { state: { ...state, relay: next.state }, outgoing: next.outgoing }
    }
  }
}
