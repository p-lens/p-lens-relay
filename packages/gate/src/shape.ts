import { type NostrEvent } from "@p-lens-relay/core"
import { kindName, type KindName } from "./kinds"
import { paddedLength } from "@p-lens-relay/reference/pad"

/** Why an event is not a PLN-1 event, whatever the relay's mode. */
export type ShapeFault =
  | { readonly type: "foreign-kind"; readonly kind: number }
  | { readonly type: "wrong-tags" }
  | { readonly type: "unrounded-expiration" }
  | { readonly type: "unsealed-content" }

type Content = "sealed" | "access-list" | "empty"

/** The tags a kind carries, each exactly once, and nothing else; and what its content is. */
type Shape = { readonly tags: readonly string[]; readonly content: Content }

const SHAPES: Readonly<Record<Exclude<KindName, "deletion">, Shape>> = {
  bookChange: { tags: ["v"], content: "sealed" },
  tip: { tags: ["v", "d"], content: "sealed" },
  accessList: { tags: ["v", "d"], content: "access-list" },
  mailbox: { tags: ["v", "d"], content: "sealed" },
  playCopy: { tags: ["v", "d", "expiration"], content: "sealed" },
  sentPlay: { tags: ["v", "d", "expiration"], content: "sealed" },
  huddleState: { tags: ["v", "d", "expiration"], content: "sealed" },
  redemption: { tags: ["v", "claim"], content: "empty" },
}

const DAY = 86_400

const OPAQUE = /^[0-9a-f]{32}$/

const HEX64 = /^[0-9a-f]{64}$/

const BASE64 = /^(?:[A-Za-z0-9+/]{4})+(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Version, nonce and AES-GCM tag around the padded plaintext (PROTOCOL.md §3.3). */
const SEAL_OVERHEAD = 1 + 12 + 16

const valueHolds = (name: string, value: string): boolean => {
  switch (name) {
    case "v":
    case "d":
      return OPAQUE.test(value)
    case "expiration":
      return /^[1-9][0-9]{0,11}$/.test(value)
    case "claim":
      return value.length > 0 && value.length <= 2_048
    default:
      return false
  }
}

const tagsHold = (event: NostrEvent, names: readonly string[]): boolean =>
  event.tags.length === names.length &&
  names.every((name) => event.tags.filter((tag) => tag[0] === name).length === 1) &&
  event.tags.every((tag) => tag.length === 2 && valueHolds(tag[0] ?? "", tag[1] ?? ""))

const decodedLength = (content: string): number => (content.length / 4) * 3 - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0)

/** Whether content could be a seal: base64 of version 1, a nonce, a padded plaintext of a padded length, and a tag. */
export const looksSealed = (content: string): boolean => {
  if (!BASE64.test(content)) return false
  const padded = decodedLength(content) - SEAL_OVERHEAD - 2
  return padded >= 32 && paddedLength(padded) === padded && padded <= paddedLength(32_000) && atob(content.slice(0, 4)).charCodeAt(0) === 1
}

const contentHolds = (content: Content, event: NostrEvent): boolean => {
  switch (content) {
    case "sealed":
      return looksSealed(event.content)
    case "empty":
      return event.content === ""
    case "access-list":
      return true
  }
}

const deletionHolds = (event: NostrEvent): boolean =>
  event.tags.length > 0 &&
  event.tags.every((tag) => tag.length === 2 && ((tag[0] === "e" && HEX64.test(tag[1] ?? "")) || (tag[0] === "k" && /^[0-9]{1,5}$/.test(tag[1] ?? ""))))

const expirationRounded = (event: NostrEvent): boolean =>
  event.tags.every((tag) => tag[0] !== "expiration" || Number(tag[1]) % DAY === 0)

/**
 * What keeps an event within PLN-1 on any P-Lens relay: its kind is one of
 * PROTOCOL.md §4's, it carries exactly the tags its kind does with opaque
 * values, its expiry is a whole day, and its content is a seal. It is how the
 * relay holds a client to §1.2, so that a client's mistake leaks nothing
 * readable into the store.
 */
export const shapeFault = (event: NostrEvent): ShapeFault | undefined => {
  const name = kindName(event.kind)
  if (name === undefined) return { type: "foreign-kind", kind: event.kind }
  if (name === "deletion") return deletionHolds(event) && event.content === "" ? undefined : { type: "wrong-tags" }
  const shape = SHAPES[name]
  if (!tagsHold(event, shape.tags)) return { type: "wrong-tags" }
  if (!expirationRounded(event)) return { type: "unrounded-expiration" }
  if (!contentHolds(shape.content, event)) return { type: "unsealed-content" }
  return undefined
}
