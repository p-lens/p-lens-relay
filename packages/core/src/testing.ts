import { schnorr } from "@noble/curves/secp256k1.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js"
import { eventId, type NostrEvent } from "./event"

/** Test writers and signing, for this repository's tests alone. */
export type Writer = { readonly secret: Uint8Array; readonly pubkey: string }

/** A writer from a seed byte, the same every run. */
export const writer = (seed: number): Writer => {
  const secret = new Uint8Array(32).fill(seed)
  return { secret, pubkey: bytesToHex(schnorr.getPublicKey(secret)) }
}

export type Draft = { readonly kind: number; readonly created_at: number; readonly tags?: readonly (readonly string[])[]; readonly content?: string }

export const signed = (by: Writer, draft: Draft): NostrEvent => {
  const unsigned = { pubkey: by.pubkey, created_at: draft.created_at, kind: draft.kind, tags: draft.tags ?? [], content: draft.content ?? "" }
  const id = eventId(unsigned)
  return { ...unsigned, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), by.secret, new Uint8Array(32))) }
}
