import { invalidityOf, type Invalidity, type NostrEvent } from "./event"
import { isFilter, type Filter } from "./filter"
import type { Admission } from "./keeping"
import type { Rules } from "./rules"

/** What a client sent, read: NIP-01's three messages, or why it could not be taken. */
export type ClientMessage =
  | { readonly type: "event"; readonly event: NostrEvent; readonly size: number }
  | { readonly type: "invalid-event"; readonly id: string; readonly invalidity: Invalidity }
  | { readonly type: "req"; readonly id: string; readonly filters: readonly Filter[] }
  | { readonly type: "bad-filter"; readonly id: string }
  | { readonly type: "close"; readonly id: string }
  | { readonly type: "unreadable"; readonly notice: string }

export type RelayMessage =
  | readonly ["EVENT", string, NostrEvent]
  | readonly ["OK", string, boolean, string]
  | readonly ["EOSE", string]
  | readonly ["CLOSED", string, string]
  | readonly ["NOTICE", string]

const parsed = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

const isSubscriptionId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 64

const idOf = (value: unknown): string => {
  const id = (value as { id?: unknown } | null)?.id
  return typeof id === "string" ? id : ""
}

const eventMessage = (value: unknown, raw: string): ClientMessage => {
  const invalidity = invalidityOf(value)
  return invalidity === undefined
    ? { type: "event", event: value as NostrEvent, size: new TextEncoder().encode(raw).length }
    : { type: "invalid-event", id: idOf(value), invalidity }
}

export const readClientMessage = (raw: string): ClientMessage => {
  const message = parsed(raw)
  if (!Array.isArray(message)) return { type: "unreadable", notice: "invalid: not a JSON array" }
  const [verb, first, ...rest] = message as readonly unknown[]
  switch (verb) {
    case "EVENT":
      return eventMessage(first, raw)
    case "REQ":
      if (!isSubscriptionId(first)) return { type: "unreadable", notice: "invalid: subscription id" }
      return rest.length > 0 && rest.every(isFilter) ? { type: "req", id: first, filters: rest } : { type: "bad-filter", id: first }
    case "CLOSE":
      return isSubscriptionId(first) ? { type: "close", id: first } : { type: "unreadable", notice: "invalid: subscription id" }
    default:
      return { type: "unreadable", notice: "invalid: unknown message" }
  }
}

/** Why a valid event is refused before anything is kept, by its size and its time. */
export const refusalBeforeKeeping = (rules: Rules, event: NostrEvent, size: number, now: number): string | undefined => {
  if (size > rules.maxEventBytes) return "invalid: event too large"
  if (event.created_at > now + rules.maxFutureSeconds) return "invalid: created_at too far ahead"
  return undefined
}

/** The `OK` an admission is answered with. */
export const answerOf = (admission: Admission): readonly [boolean, string] => {
  switch (admission.type) {
    case "stored":
    case "passed":
      return [true, ""]
    case "duplicate":
      return [true, "duplicate: already have this event"]
    case "deleted":
      return [false, "blocked: deleted by its author"]
    case "have-newer":
      return [false, "replaced: have newer event"]
  }
}
