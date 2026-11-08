import { dOf, tagValues, type NostrEvent, type Store } from "@p-lens-relay/core"
import { accessListOf, type AccessList, type ListedProduct } from "./access-list"
import { KIND, type Product } from "./kinds"
import { capNow, grantKey, type Ledger } from "./ledger"

/** An owner's access list for a product, and the `d` it is kept at. */
export type HeldList = { readonly owner: string; readonly d: string; readonly list: AccessList }

/**
 * What the gate asks of what the relay holds, as of one moment: kept apart
 * from how it is held, so that the same judgement runs over memory here and
 * over a Durable Object's SQLite in the official relay.
 */
export type GateView = {
  readonly capNow: (subject: string, product: Product) => number | undefined
  readonly isSpent: (ticket: string) => boolean
  readonly accessList: (owner: string, product: ListedProduct) => HeldList | undefined
  readonly listedBy: (member: string, role: "editor" | "sender") => readonly HeldList[]
  readonly huddleAuthors: (v: string) => ReadonlySet<string>
}

const heldList = (event: NostrEvent): readonly HeldList[] => {
  const list = event.kind === KIND.accessList ? accessListOf(event.content) : undefined
  return list === undefined ? [] : [{ owner: event.pubkey, d: dOf(event), list }]
}

const lists = (member: string, role: "editor" | "sender", held: readonly HeldList[]): readonly HeldList[] =>
  held.filter(({ list }) => list.members.some((listed) => listed.role === role && listed.pubkey === member))

/** The view over a relay held in memory. */
export const memoryView = (store: Store, ledger: Ledger, now: number): GateView => {
  const held = store.events.flatMap(heldList)
  return {
    capNow: (subject, product) => capNow(ledger, grantKey(subject, product), now),
    isSpent: (ticket) => ledger.spent.has(ticket),
    accessList: (owner, product) => held.find((candidate) => candidate.owner === owner && candidate.list.product === product),
    listedBy: (member, role) => lists(member, role, held),
    huddleAuthors: (v) =>
      new Set(store.events.filter((event) => event.kind === KIND.huddleState && tagValues(event, "v").includes(v)).map((event) => event.pubkey)),
  }
}
