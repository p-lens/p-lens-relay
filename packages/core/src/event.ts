import { schnorr } from "@noble/curves/secp256k1.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"

export type NostrEvent = {
  readonly id: string
  readonly pubkey: string
  readonly created_at: number
  readonly kind: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
  readonly sig: string
}

/** How NIP-01 keeps a kind: every event, the latest per author, the latest per author and `d`, or none. */
export type KindClass = "regular" | "replaceable" | "addressable" | "ephemeral"

export const kindClass = (kind: number): KindClass => {
  if (kind === 0 || kind === 3 || (kind >= 10_000 && kind < 20_000)) return "replaceable"
  if (kind >= 20_000 && kind < 30_000) return "ephemeral"
  if (kind >= 30_000 && kind < 40_000) return "addressable"
  return "regular"
}

export type Invalidity =
  | { readonly type: "malformed" }
  | { readonly type: "wrong-id" }
  | { readonly type: "bad-signature" }

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

const isWellFormed = (value: unknown): value is NostrEvent => {
  const event = value as Record<string, unknown>
  return (
    typeof value === "object" &&
    value !== null &&
    typeof event.id === "string" &&
    HEX64.test(event.id) &&
    typeof event.pubkey === "string" &&
    HEX64.test(event.pubkey) &&
    typeof event.sig === "string" &&
    HEX128.test(event.sig) &&
    Number.isSafeInteger(event.created_at) &&
    Number.isSafeInteger(event.kind) &&
    (event.kind as number) >= 0 &&
    (event.kind as number) <= 65_535 &&
    typeof event.content === "string" &&
    Array.isArray(event.tags) &&
    event.tags.every((tag) => Array.isArray(tag) && tag.every((part) => typeof part === "string"))
  )
}

/** NIP-01's id: the SHA-256 of the event serialized without its id and signature. */
export const eventId = (event: Omit<NostrEvent, "id" | "sig">): string =>
  bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))))

const signatureHolds = (event: NostrEvent): boolean => {
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))
  } catch {
    return false
  }
}

/** What is wrong with something sent as an event, if anything. */
export const invalidityOf = (value: unknown): Invalidity | undefined => {
  if (!isWellFormed(value)) return { type: "malformed" }
  if (eventId(value) !== value.id) return { type: "wrong-id" }
  if (!signatureHolds(value)) return { type: "bad-signature" }
  return undefined
}

export const tagValues = (event: NostrEvent, name: string): readonly string[] =>
  event.tags.flatMap((tag) => (tag[0] === name && tag[1] !== undefined ? [tag[1]] : []))

/** The `d` of an addressable event: its first `d` tag's value, or empty. */
export const dOf = (event: NostrEvent): string => tagValues(event, "d")[0] ?? ""
