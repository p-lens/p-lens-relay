import { kindClass, tagValues, type NostrEvent } from "./event"
import { matches, type Filter } from "./filter"
import { isExpired, joined, newestFirst, replaces, slotOf, takenOf, type Admission, type DefaultLimit, type Tie } from "./keeping"

/** A relay's events held in memory. */
export type Store = {
  readonly events: readonly NostrEvent[]
  /** `pubkey:id` of every event its author has deleted, so that it is not taken again. */
  readonly deleted: ReadonlySet<string>
}

export const emptyStore: Store = { events: [], deleted: new Set() }

const deletionKey = (pubkey: string, id: string): string => `${pubkey}:${id}`

const withDeletion = (store: Store, deletion: NostrEvent): Store => {
  const targets = new Set(tagValues(deletion, "e"))
  const gone = (event: NostrEvent): boolean => event.pubkey === deletion.pubkey && targets.has(event.id)
  return {
    events: [...store.events.filter((event) => !gone(event)), deletion],
    deleted: new Set([...store.deleted, ...[...targets].map((id) => deletionKey(deletion.pubkey, id))]),
  }
}

const stored = (store: Store, replaced: NostrEvent | undefined): { readonly store: Store; readonly admission: Admission } => ({
  store,
  admission: { type: "stored", replaced },
})

/** Takes an event in as NIP-01 and NIP-09 say, breaking a same-second tie by the rule given. */
export const admit = (tie: Tie, store: Store, event: NostrEvent): { readonly store: Store; readonly admission: Admission } => {
  if (store.events.some((held) => held.id === event.id)) return { store, admission: { type: "duplicate" } }
  if (store.deleted.has(deletionKey(event.pubkey, event.id))) return { store, admission: { type: "deleted" } }
  if (kindClass(event.kind) === "ephemeral") return { store, admission: { type: "passed" } }
  if (event.kind === 5) return stored(withDeletion(store, event), undefined)
  const slot = slotOf(event)
  const held = slot === undefined ? undefined : store.events.find((candidate) => slotOf(candidate) === slot)
  if (held === undefined) return stored({ ...store, events: [...store.events, event] }, undefined)
  if (!replaces(tie, event, held)) return { store, admission: { type: "have-newer" } }
  return stored({ ...store, events: [...store.events.filter((candidate) => candidate !== held), event] }, held)
}

const taken = (sorted: readonly NostrEvent[], count: number | "oldest-all"): readonly NostrEvent[] =>
  count === "oldest-all" ? [...sorted].reverse() : sorted.slice(0, count)

/** What each filter finds, newest first, limited, and together without repeats. */
export const query = (
  store: Store,
  filters: readonly Filter[],
  defaultLimit: DefaultLimit,
  maxLimit: number,
  now: number,
): readonly NostrEvent[] => {
  const live = store.events.filter((event) => !isExpired(event, now))
  return joined(
    filters.map((filter) =>
      taken(
        live.filter((event) => matches(filter, event)).sort(newestFirst),
        takenOf(filter, defaultLimit, maxLimit),
      ),
    ),
  )
}
