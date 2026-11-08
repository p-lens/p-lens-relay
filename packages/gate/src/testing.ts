import type { NostrEvent } from "@p-lens-relay/core"
import { signed, type Writer } from "@p-lens-relay/core/testing"
import { KIND } from "./kinds"

/** Events shaped as P-Lens clients write them, for this repository's tests alone, written at 2026-11-15 00:00 UTC: the middle of the month the tests' tickets pay for. */
export const NOW = Date.UTC(2026, 10, 15) / 1000

export const DAY = 86_400

/** An expiry rounded to a whole day, as a client writes one. */
export const EXPIRY = String(Date.UTC(2026, 10, 20) / 1000)

/** A `v` or `d` as a client derives one: 32 lowercase hex digits, a different one for each seed. */
export const opaque = (seed: number): string => seed.toString(16).padStart(32, "0")

/** Content shaped as a seal: version 1, a nonce, a padded plaintext of the length given, a tag. */
export const sealedContent = (padded = 32): string => {
  const bytes = new Uint8Array(1 + 12 + 2 + padded + 16).fill(7)
  bytes[0] = 1
  return Buffer.from(bytes).toString("base64")
}

type Tags = readonly (readonly string[])[]

const at = (by: Writer, kind: number, tags: Tags, content = sealedContent(), created_at = NOW): NostrEvent =>
  signed(by, { kind, created_at, tags, content })

export const bookChange = (by: Writer, v = opaque(1), created_at = NOW): NostrEvent => at(by, KIND.bookChange, [["v", v]], sealedContent(), created_at)

export const playCopy = (by: Writer, d = opaque(3)): NostrEvent =>
  at(by, KIND.playCopy, [["v", opaque(2)], ["d", d], ["expiration", EXPIRY]])

export const sentPlay = (by: Writer, d = opaque(4)): NostrEvent =>
  at(by, KIND.sentPlay, [["v", opaque(5)], ["d", d], ["expiration", EXPIRY]])

export const huddleState = (by: Writer, v = opaque(6), d = opaque(7)): NostrEvent =>
  at(by, KIND.huddleState, [["v", v], ["d", d], ["expiration", EXPIRY]])


export const mailbox = (by: Writer, v: string): NostrEvent => at(by, KIND.mailbox, [["v", v], ["d", opaque(8)]])

export type ListedMember =
  | { readonly role: "editor" | "sender"; readonly pubkey: string; readonly mailbox: string }
  | { readonly role: "viewer"; readonly mailbox: string }

export const accessList = (
  by: Writer,
  product: "sharing" | "sending",
  members: readonly ListedMember[],
  d = product === "sharing" ? opaque(9) : opaque(10),
  created_at = NOW,
): NostrEvent => at(by, KIND.accessList, [["v", opaque(11)], ["d", d]], JSON.stringify({ product, members, stamp: 1 }), created_at)

export const deletion = (by: Writer, target: NostrEvent): NostrEvent => at(by, KIND.deletion, [["e", target.id]], "")

export const redemption = (by: Writer, claim: string, v = opaque(11)): NostrEvent => at(by, KIND.redemption, [["v", v], ["claim", claim]], "")
