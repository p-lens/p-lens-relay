import { RULES, type NostrEvent, type Outgoing } from "@p-lens-relay/core"
import { signed, writer, type Writer } from "@p-lens-relay/core/testing"
import { describe, expect, test } from "bun:test"
import { CAPS, emptyGated, gatedStep, type GateConfig, type GatedState, type Mode, type Product, type TicketReader } from "../src"
import {
  accessList,
  bookChange,
  DAY,
  deletion,
  huddleState,
  mailbox,
  NOW,
  opaque,
  playCopy,
  redemption,
  sentPlay,
  type ListedMember,
} from "../src/testing"

const owner = writer(1)
const editor = writer(2)
const sender = writer(3)
const stranger = writer(4)

const config = (mode: Mode): GateConfig => ({ mode, caps: CAPS })

/** Tickets as `product:cap:period:key`, read without the issuer's key: what the issuer's key decides is tested with the issuer. */
const readTicket: TicketReader = async (claim) => {
  const [product, cap, period, key] = claim.split(":")
  return product === undefined || cap === undefined || period === undefined || key === undefined
    ? { type: "invalid" }
    : { type: "valid", product: product as Product, cap: Number(cap), period, key }
}

type Run = { readonly state: GatedState; readonly answers: readonly (readonly [boolean, string])[]; readonly outgoing: readonly Outgoing[] }

const send = async (mode: Mode, events: readonly NostrEvent[], from: GatedState = emptyGated, now = NOW): Promise<Run> => {
  const start: Run = { state: from, answers: [], outgoing: [] }
  return events.reduce<Promise<Run>>(async (pending, event) => {
    const sofar = await pending
    const next = await gatedStep(config(mode), RULES, readTicket, sofar.state, "writer", JSON.stringify(["EVENT", event]), now)
    const answers = next.outgoing.flatMap((out) => (out.message[0] === "OK" ? [[out.message[2], out.message[3]] as const] : []))
    return { state: next.state, answers: [...sofar.answers, ...answers], outgoing: [...sofar.outgoing, ...next.outgoing] }
  }, Promise.resolve(start))
}

const last = (run: Run): readonly [boolean, string] | undefined => run.answers.at(-1)

const ACCEPTED = [true, ""] as const

const editorOf = (by: Writer, seed: number): ListedMember => ({ role: "editor", pubkey: by.pubkey, mailbox: opaque(seed) })
const senderOf = (by: Writer, seed: number): ListedMember => ({ role: "sender", pubkey: by.pubkey, mailbox: opaque(seed) })
const viewers = (count: number, from = 100): readonly ListedMember[] => Array.from({ length: count }, (_, n) => ({ role: "viewer", mailbox: opaque(from + n) }))
const participants = (count: number): readonly Writer[] => Array.from({ length: count }, (_, n) => writer(50 + n))

const ticket = (product: Product, cap: number, key: string, period = "2026-11"): string => `${product}:${cap}:${period}:${key}`

describe("an open relay", () => {
  test("takes every P-Lens event from anyone, without caps", async () => {
    const run = await send("open", [
      bookChange(stranger),
      playCopy(stranger),
      sentPlay(stranger),
      mailbox(stranger, opaque(99)),
      accessList(stranger, "sharing", viewers(31)),
      ...participants(31).map((participant) => huddleState(participant)),
    ])
    expect(run.answers.every(([accepted]) => accepted)).toBe(true)
  })

  test("still refuses what is not P-Lens's, and takes no payment", async () => {
    const run = await send("open", [redemption(owner, ticket("sync", 1, "k1"))])
    expect(last(run)).toEqual([false, "restricted: this relay takes no payment"])
  })
})

describe("a capped relay", () => {
  test("holds a huddle to thirty people, who go on writing once in", async () => {
    const thirty = participants(30)
    const full = await send("capped", thirty.map((participant) => huddleState(participant)))
    expect(full.answers.every(([accepted]) => accepted)).toBe(true)
    expect(last(await send("capped", [huddleState(writer(99))], full.state))).toEqual([false, "restricted: full"])
    expect(last(await send("capped", [huddleState(thirty[0] as Writer, opaque(6), opaque(8))], full.state))).toEqual(ACCEPTED)
  })

  test("holds sharing to thirty and sending to two hundred", async () => {
    expect(last(await send("capped", [accessList(owner, "sharing", viewers(30))]))).toEqual(ACCEPTED)
    expect(last(await send("capped", [accessList(owner, "sharing", viewers(31))]))).toEqual([false, "restricted: full"])
    const senders = (count: number) => Array.from({ length: count }, (_, n) => senderOf(writer(10 + n), 300 + n))
    expect(last(await send("capped", [accessList(owner, "sending", senders(200))]))).toEqual(ACCEPTED)
    expect(last(await send("capped", [accessList(owner, "sending", senders(201))]))).toEqual([false, "restricted: full"])
  })

  test("keeps one access list for a product per owner, so that a cap cannot be split", async () => {
    const first = await send("capped", [accessList(owner, "sharing", viewers(20), opaque(9))])
    expect(last(await send("capped", [accessList(owner, "sharing", viewers(20, 200), opaque(12))], first.state))).toEqual([
      false,
      "invalid: one sharing access list per owner",
    ])
    expect(last(await send("capped", [accessList(owner, "sharing", viewers(25), opaque(9), NOW + 1)], first.state))).toEqual(ACCEPTED)
  })

  test("takes mailboxes and sent plays only for those listed", async () => {
    const listed = await send("capped", [accessList(owner, "sending", [senderOf(sender, 20)])])
    expect(last(await send("capped", [mailbox(owner, opaque(20))], listed.state))).toEqual(ACCEPTED)
    expect(last(await send("capped", [mailbox(owner, opaque(21))], listed.state))).toEqual([false, "restricted: not on the access list"])
    expect(last(await send("capped", [mailbox(stranger, opaque(20))], listed.state))).toEqual([false, "restricted: not on the access list"])
    expect(last(await send("capped", [sentPlay(sender)], listed.state))).toEqual(ACCEPTED)
    expect(last(await send("capped", [sentPlay(stranger)], listed.state))).toEqual([false, "restricted: not on the access list"])
  })
})

describe("a gated relay", () => {
  test("refuses a book's line until it is paid for, and takes it after", async () => {
    expect(last(await send("gated", [bookChange(owner)]))).toEqual([false, "restricted: pass-required for sync"])
    const paid = await send("gated", [redemption(owner, ticket("sync", 1, "k1")), bookChange(owner), playCopy(owner)])
    expect(paid.answers).toEqual([ACCEPTED, ACCEPTED, ACCEPTED])
  })

  test("opens a book's line by sharing alone, but not its plays", async () => {
    const run = await send("gated", [redemption(owner, ticket("sharing", 5, "k1")), bookChange(owner), playCopy(owner)])
    expect(run.answers).toEqual([ACCEPTED, ACCEPTED, [false, "restricted: pass-required for sync"]])
  })

  test("spends a ticket once", async () => {
    const run = await send("gated", [redemption(owner, ticket("sync", 1, "k1")), redemption(stranger, ticket("sync", 1, "k1"))])
    expect(last(run)).toEqual([false, "invalid: ticket already redeemed"])
  })

  test.each([
    ["no ticket at all", "garbage", "invalid: ticket"],
    ["a month that is over", ticket("sync", 1, "k1", "2026-09"), "invalid: ticket not for this month"],
    ["a month too far ahead", ticket("sync", 1, "k1", "2027-01"), "invalid: ticket not for this month"],
    ["a month that is no month", ticket("sync", 1, "k1", "2026-13"), "invalid: ticket"],
    ["a cap of nothing", ticket("sharing", 0, "k1"), "invalid: ticket"],
  ])("refuses %s", async (_, claim, reason) => {
    expect(last(await send("gated", [redemption(owner, claim)]))).toEqual([false, reason])
  })

  test("takes next month's ticket in the week before it", async () => {
    expect(last(await send("gated", [redemption(owner, ticket("sync", 1, "k1", "2026-12"))], emptyGated, NOW + 10 * DAY))).toEqual(ACCEPTED)
  })

  test("goes on taking writes for the grace after a month, and stops", async () => {
    const paid = await send("gated", [redemption(owner, ticket("sync", 1, "k1"))])
    const monthEnd = Date.UTC(2026, 11, 1) / 1000
    expect(last(await send("gated", [bookChange(owner, opaque(1), monthEnd + 2 * DAY)], paid.state, monthEnd + 2 * DAY))).toEqual(ACCEPTED)
    expect(last(await send("gated", [bookChange(owner, opaque(1), monthEnd + 3 * DAY)], paid.state, monthEnd + 3 * DAY))).toEqual([
      false,
      "restricted: pass-required for sync",
    ])
  })

  test("never passes a ticket on to a subscriber", async () => {
    const subscribed = await gatedStep(config("gated"), RULES, readTicket, emptyGated, "reader", JSON.stringify(["REQ", "s", {}]), NOW)
    const run = await send("gated", [redemption(owner, ticket("sync", 1, "k1"))], subscribed.state)
    expect(run.outgoing.filter((out) => out.to === "reader")).toEqual([])
  })

  test("holds an access list to the cap paid for", async () => {
    const paid = await send("gated", [redemption(owner, ticket("sharing", 3, "k1"))])
    expect(last(await send("gated", [accessList(owner, "sharing", viewers(3))], paid.state))).toEqual(ACCEPTED)
    expect(last(await send("gated", [accessList(owner, "sharing", viewers(4))], paid.state))).toEqual([false, "restricted: full"])
    expect(last(await send("gated", [accessList(owner, "sending", [senderOf(sender, 1)])], paid.state))).toEqual([
      false,
      "restricted: pass-required for sending",
    ])
  })

  test("lets an editor write while the owner pays for sharing", async () => {
    const shared = await send("gated", [redemption(owner, ticket("sharing", 2, "k1")), accessList(owner, "sharing", [editorOf(editor, 1), ...viewers(1)])])
    expect(last(await send("gated", [bookChange(editor)], shared.state))).toEqual(ACCEPTED)
    expect(last(await send("gated", [playCopy(editor)], shared.state))).toEqual([false, "restricted: pass-required for sync"])
    const lapsed = Date.UTC(2026, 11, 5) / 1000
    expect(last(await send("gated", [bookChange(editor, opaque(1), lapsed)], shared.state, lapsed))).toEqual([
      false,
      "restricted: pass-required for sharing",
    ])
  })

  test("stops members writing when a smaller plan leaves the list over its cap", async () => {
    const november = await send("gated", [redemption(owner, ticket("sharing", 5, "k1")), accessList(owner, "sharing", [editorOf(editor, 1), ...viewers(3)])])
    const december = Date.UTC(2026, 11, 10) / 1000
    const smaller = await send("gated", [redemption(owner, ticket("sharing", 2, "k2", "2026-12"))], november.state, december)
    expect(last(await send("gated", [bookChange(editor, opaque(1), december)], smaller.state, december))).toEqual([false, "restricted: full"])
    const trimmed = await send("gated", [accessList(owner, "sharing", [editorOf(editor, 1), ...viewers(1)], opaque(9), december)], smaller.state, december)
    expect(last(await send("gated", [bookChange(editor, opaque(1), december + 1)], trimmed.state, december))).toEqual(ACCEPTED)
  })

  test("lets a listed sender send while the owner pays for sending", async () => {
    const listed = await send("gated", [redemption(owner, ticket("sending", 200, "k1")), accessList(owner, "sending", [senderOf(sender, 1)])])
    expect(last(await send("gated", [sentPlay(sender)], listed.state))).toEqual(ACCEPTED)
    expect(last(await send("gated", [sentPlay(stranger)], listed.state))).toEqual([false, "restricted: not on the access list"])
    expect(last(await send("gated", [bookChange(sender)], listed.state))).toEqual([false, "restricted: pass-required for sync"])
  })

  test("binds a huddle's ticket to its line and holds it to its cap", async () => {
    const starter = writer(50)
    const paid = await send("gated", [redemption(starter, ticket("huddles", 4, "k1"), opaque(6))])
    const four = await send("gated", participants(4).map((participant) => huddleState(participant)), paid.state)
    expect(four.answers.every(([accepted]) => accepted)).toBe(true)
    expect(last(await send("gated", [huddleState(writer(98))], four.state))).toEqual([false, "restricted: full"])
    expect(last(await send("gated", [huddleState(starter, opaque(60))], four.state))).toEqual([false, "restricted: pass-required for huddles"])
  })

  test("takes mailboxes only for a product the owner pays for", async () => {
    const listed = await send("capped", [accessList(owner, "sending", [senderOf(sender, 20)])])
    const lapsed = Date.UTC(2026, 11, 10) / 1000
    const paid = await send("gated", [redemption(owner, ticket("sending", 10, "k1")), accessList(owner, "sending", [senderOf(sender, 20)])])
    expect(last(await send("gated", [mailbox(owner, opaque(20))], paid.state))).toEqual(ACCEPTED)
    expect(last(await send("gated", [mailbox(owner, opaque(20))], paid.state, lapsed))).toEqual([false, "restricted: pass-required for sending"])
    expect(last(await send("gated", [mailbox(owner, opaque(20))], listed.state))).toEqual([false, "restricted: pass-required for sending"])
  })

  test("takes deletions only from those who may write, so the store is not filled unpaid", async () => {
    const paid = await send("gated", [redemption(owner, ticket("sync", 1, "k1")), bookChange(owner)])
    const change = bookChange(owner)
    expect(last(await send("gated", [deletion(owner, change)], paid.state))).toEqual(ACCEPTED)
    expect(last(await send("gated", [deletion(stranger, change)], paid.state))).toEqual([false, "restricted: pass-required for sync"])
    const shared = await send("gated", [redemption(owner, ticket("sharing", 2, "k2")), accessList(owner, "sharing", [editorOf(editor, 1)])])
    expect(last(await send("gated", [deletion(editor, change)], shared.state))).toEqual(ACCEPTED)
  })

  test("refuses what is not P-Lens's, paid for or not", async () => {
    const paid = await send("gated", [redemption(owner, ticket("sync", 1, "k1"))])
    const note = signed(owner, { kind: 1, created_at: NOW, tags: [], content: "hello" })
    expect(last(await send("gated", [note], paid.state))).toEqual([false, "blocked: kind 1 is not P-Lens's"])
    expect(last(await send("open", [note]))).toEqual([false, "blocked: kind 1 is not P-Lens's"])
  })
})
