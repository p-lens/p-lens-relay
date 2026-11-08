import { dOf, kindClass, tagValues, type NostrEvent } from "./event"
import type { Filter } from "./filter"

/** Which version of a replaceable or addressable event stays when two share a second. */
export type Tie = "lowest-id" | "first-arrival"

/** What a filter without a limit is given. */
export type DefaultLimit = { readonly order: "newest"; readonly count: number } | { readonly order: "oldest-all" }

/** How a relay answers an event it was sent, once the event is valid. */
export type Admission =
  | { readonly type: "stored"; readonly replaced: NostrEvent | undefined }
  | { readonly type: "passed" }
  | { readonly type: "duplicate" }
  | { readonly type: "deleted" }
  | { readonly type: "have-newer" }

/** The one place a replaceable or addressable event is kept at, if it is one. */
export const slotOf = (event: NostrEvent): string | undefined => {
  switch (kindClass(event.kind)) {
    case "replaceable":
      return `${event.kind}:${event.pubkey}`
    case "addressable":
      return `${event.kind}:${event.pubkey}:${dOf(event)}`
    case "regular":
    case "ephemeral":
      return undefined
  }
}

/** Whether an arriving version takes its slot from the one held. */
export const replaces = (tie: Tie, arriving: NostrEvent, held: NostrEvent): boolean => {
  if (arriving.created_at !== held.created_at) return arriving.created_at > held.created_at
  switch (tie) {
    case "lowest-id":
      return arriving.id < held.id
    case "first-arrival":
      return false
  }
}

/** When an event runs out by NIP-40, if it says. */
export const expirationOf = (event: NostrEvent): number | undefined => {
  const expiration = Number(tagValues(event, "expiration")[0])
  return Number.isSafeInteger(expiration) ? expiration : undefined
}

export const isExpired = (event: NostrEvent, now: number): boolean => {
  const expiration = expirationOf(event)
  return expiration !== undefined && expiration <= now
}

/** How many of a filter's events, newest first, it is given: a number, or all of them oldest first. */
export const takenOf = (filter: Filter, defaultLimit: DefaultLimit, maxLimit: number): number | "oldest-all" => {
  if (filter.limit !== undefined) return Math.min(filter.limit, maxLimit)
  switch (defaultLimit.order) {
    case "newest":
      return defaultLimit.count
    case "oldest-all":
      return "oldest-all"
  }
}

/** Newer first; in one second, the lower id first, as NIP-01 breaks a tie. */
export const newestFirst = (a: NostrEvent, b: NostrEvent): number =>
  b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** What several filters found, each newest first, joined without repeats. */
export const joined = (found: readonly (readonly NostrEvent[])[]): readonly NostrEvent[] => {
  const flat = found.flat()
  const seen = new Set<string>()
  return flat.filter((event) => !seen.has(event.id) && seen.add(event.id) !== undefined)
}
