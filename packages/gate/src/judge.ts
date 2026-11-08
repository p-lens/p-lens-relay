import { dOf, tagValues, type NostrEvent } from "@p-lens-relay/core"
import { accessListOf, type ListedProduct } from "./access-list"
import { kindName, type Product } from "./kinds"
import { periodSpan, grantKey, type Grant } from "./ledger"
import { shapeFault, type ShapeFault } from "./shape"
import type { GateView, HeldList } from "./view"

/** How a relay holds writes: not at all, to fixed caps, or to what was paid for (PROTOCOL.md §9). */
export type Mode = "open" | "capped" | "gated"

export type CappedProduct = Exclude<Product, "sync">

export type GateConfig = { readonly mode: Mode; readonly caps: Readonly<Record<CappedProduct, number>> }

/** The caps the official relay holds every line to before payment (PROTOCOL.md §9.4). */
export const CAPS: Readonly<Record<CappedProduct, number>> = { sharing: 30, sending: 200, huddles: 30 }

/** A ticket as the issuer's key reads it: what it pays for, or that it is no ticket. */
export type TicketReading =
  | { readonly type: "valid"; readonly product: Product; readonly cap: number; readonly period: string; readonly key: string }
  | { readonly type: "invalid" }

export type Refusal =
  | { readonly type: "shape"; readonly fault: ShapeFault }
  | { readonly type: "bad-list" }
  | { readonly type: "second-list"; readonly product: ListedProduct }
  | { readonly type: "pass-required"; readonly product: Product }
  | { readonly type: "full" }
  | { readonly type: "not-listed" }
  | { readonly type: "no-payment-here" }
  | { readonly type: "bad-ticket" }
  | { readonly type: "ticket-spent" }
  | { readonly type: "ticket-out-of-period" }

export type Verdict =
  | { readonly type: "accept" }
  | { readonly type: "redeem"; readonly key: string; readonly grant: Grant; readonly ticket: string }
  | { readonly type: "refuse"; readonly refusal: Refusal }

const ACCEPT: Verdict = { type: "accept" }

const refuse = (refusal: Refusal): Verdict => ({ type: "refuse", refusal })

/** How far ahead of its month a ticket may be redeemed. */
const AHEAD_SECONDS = 7 * 86_400

/** The cap a subject is held to now: none on an open relay, the fixed one when capped, what was paid for when gated. */
const capFor = (config: GateConfig, view: GateView, subject: string, product: CappedProduct): number | undefined => {
  switch (config.mode) {
    case "open":
      return Number.POSITIVE_INFINITY
    case "capped":
      return config.caps[product]
    case "gated":
      return view.capNow(subject, product)
  }
}

const within = (count: number, cap: number | undefined, product: Product): Verdict => {
  if (cap === undefined) return refuse({ type: "pass-required", product })
  return count <= cap ? ACCEPT : refuse({ type: "full" })
}

/** A member's write: accepted by any list it is on whose owner's cap holds the list; else full, or unpaid. */
const byListing = (config: GateConfig, view: GateView, listings: readonly HeldList[], product: ListedProduct): Verdict => {
  if (listings.length === 0) return refuse({ type: "not-listed" })
  const caps = listings.map(({ owner, list }) => ({ count: list.members.length, cap: capFor(config, view, owner, product) }))
  if (caps.some(({ count, cap }) => cap !== undefined && count <= cap)) return ACCEPT
  if (caps.some(({ cap }) => cap !== undefined)) return refuse({ type: "full" })
  return refuse({ type: "pass-required", product })
}

const bookWrite = (config: GateConfig, view: GateView, event: NostrEvent): Verdict => {
  if (config.mode !== "gated") return ACCEPT
  if (view.capNow(event.pubkey, "sync") !== undefined || view.capNow(event.pubkey, "sharing") !== undefined) return ACCEPT
  const listings = view.listedBy(event.pubkey, "editor")
  return listings.length === 0 ? refuse({ type: "pass-required", product: "sync" }) : byListing(config, view, listings, "sharing")
}

const accessListWrite = (config: GateConfig, view: GateView, event: NostrEvent): Verdict => {
  const list = accessListOf(event.content)
  if (list === undefined) return refuse({ type: "bad-list" })
  const held = view.accessList(event.pubkey, list.product)
  if (held !== undefined && held.d !== dOf(event)) return refuse({ type: "second-list", product: list.product })
  return within(list.members.length, capFor(config, view, event.pubkey, list.product), list.product)
}

const mailboxWrite = (config: GateConfig, view: GateView, event: NostrEvent): Verdict => {
  if (config.mode === "open") return ACCEPT
  const mailbox = tagValues(event, "v")[0]
  const products: readonly ListedProduct[] = ["sharing", "sending"]
  const product = products.find((candidate) =>
    view.accessList(event.pubkey, candidate)?.list.members.some((member) => member.mailbox === mailbox),
  )
  if (product === undefined) return refuse({ type: "not-listed" })
  return config.mode === "gated" && view.capNow(event.pubkey, product) === undefined ? refuse({ type: "pass-required", product }) : ACCEPT
}

const playWrite = (config: GateConfig, view: GateView, event: NostrEvent): Verdict =>
  config.mode === "gated" && view.capNow(event.pubkey, "sync") === undefined ? refuse({ type: "pass-required", product: "sync" }) : ACCEPT

const sentPlayWrite = (config: GateConfig, view: GateView, event: NostrEvent): Verdict =>
  config.mode === "open" ? ACCEPT : byListing(config, view, view.listedBy(event.pubkey, "sender"), "sending")

const huddleWrite = (config: GateConfig, view: GateView, event: NostrEvent): Verdict => {
  if (config.mode === "open") return ACCEPT
  const v = tagValues(event, "v")[0] ?? ""
  const cap = capFor(config, view, v, "huddles")
  if (cap === undefined) return refuse({ type: "pass-required", product: "huddles" })
  const authors = view.huddleAuthors(v)
  if (authors.has(event.pubkey)) return ACCEPT
  return authors.size < cap ? ACCEPT : refuse({ type: "full" })
}

const PAID_AS_OWNER: readonly Product[] = ["sync", "sharing", "sending"]

/**
 * A deletion on a gated relay, from someone who may write there: an owner who
 * pays for something, or a member listed by one; so that it cannot be used to
 * fill the store unpaid. A huddle's states run out on their own.
 */
const deletionWrite = (config: GateConfig, view: GateView, event: NostrEvent): Verdict => {
  if (config.mode !== "gated") return ACCEPT
  if (PAID_AS_OWNER.some((product) => view.capNow(event.pubkey, product) !== undefined)) return ACCEPT
  const listings = [...view.listedBy(event.pubkey, "editor"), ...view.listedBy(event.pubkey, "sender")]
  return listings.length > 0 ? ACCEPT : refuse({ type: "pass-required", product: "sync" })
}

const redemption = (config: GateConfig, view: GateView, event: NostrEvent, ticket: TicketReading | undefined, now: number): Verdict => {
  if (config.mode !== "gated") return refuse({ type: "no-payment-here" })
  if (ticket === undefined || ticket.type === "invalid") return refuse({ type: "bad-ticket" })
  if (view.isSpent(ticket.key)) return refuse({ type: "ticket-spent" })
  const span = periodSpan(ticket.period)
  if (span === undefined || !Number.isSafeInteger(ticket.cap) || ticket.cap < 1) return refuse({ type: "bad-ticket" })
  if (span.until <= now || span.from > now + AHEAD_SECONDS) return refuse({ type: "ticket-out-of-period" })
  const subject = ticket.product === "huddles" ? (tagValues(event, "v")[0] ?? "") : event.pubkey
  return { type: "redeem", key: grantKey(subject, ticket.product), grant: { cap: ticket.cap, ...span }, ticket: ticket.key }
}

/**
 * Whether a P-Lens relay takes a signed event, as PROTOCOL.md §9 says: first
 * its shape, on every relay; then, unless the relay is open, who may write it
 * and within what cap. A ticket is read before, since reading it is the one
 * thing that cannot be done here (it needs the issuer's key, and is
 * asynchronous).
 */
export const judge = (config: GateConfig, view: GateView, event: NostrEvent, ticket: TicketReading | undefined, now: number): Verdict => {
  const fault = shapeFault(event)
  if (fault !== undefined) return refuse({ type: "shape", fault })
  switch (kindName(event.kind)) {
    case "bookChange":
    case "tip":
      return bookWrite(config, view, event)
    case "accessList":
      return accessListWrite(config, view, event)
    case "mailbox":
      return mailboxWrite(config, view, event)
    case "playCopy":
      return playWrite(config, view, event)
    case "sentPlay":
      return sentPlayWrite(config, view, event)
    case "huddleState":
      return huddleWrite(config, view, event)
    case "redemption":
      return redemption(config, view, event, ticket, now)
    case "deletion":
      return deletionWrite(config, view, event)
    case undefined:
      return refuse({ type: "shape", fault: { type: "foreign-kind", kind: event.kind } })
  }
}
