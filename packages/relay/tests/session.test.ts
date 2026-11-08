import type { NostrEvent } from "@p-lens-relay/core"
import { signed, writer, type Writer } from "@p-lens-relay/core/testing"
import { CAPS, KIND, type Mode, type Product, type TicketReader } from "@p-lens-relay/gate"
import {
  accessList,
  bookChange,
  deletion,
  EXPIRY,
  huddleState,
  mailbox,
  NOW,
  opaque,
  playCopy,
  redemption,
  sentPlay,
} from "@p-lens-relay/gate/testing"
import { describe, expect, test } from "bun:test"
import { HELD_IN_PROCESS, leave, receive, wake, type Bucket, type Holding, type Outgoing } from "../src/session"
import { settingsOf, type Settings } from "../src/settings"
import { dueOf, prune } from "../src/storage/events"
import type { Carried } from "../src/storage/subscriptions"
import { bucketSql } from "./sqlite"

const owner = writer(1)
const sender = writer(3)
const stranger = writer(4)

const base = (() => {
  const read = settingsOf({ ENTITLEMENT: "open" })
  if (!read.ok) throw new Error("the open settings are read")
  return read.value
})()

const readTicket: TicketReader = async (claim) => {
  const [product, cap, period, key] = claim.split(":")
  return product === undefined || cap === undefined || period === undefined || key === undefined
    ? { type: "invalid" }
    : { type: "valid", product: product as Product, cap: Number(cap), period, key }
}

const bucketOf = (mode: Mode, settings: Partial<Settings> = {}, holding: Holding = HELD_IN_PROCESS): Bucket => ({
  sql: bucketSql(),
  settings: { ...base, gate: { mode, caps: CAPS }, ...settings },
  readTicket,
  holding,
  held: { sockets: new Map(), spilled: new Set(), subscriptions: undefined },
})

const sendEvent = (bucket: Bucket, event: NostrEvent, from = "writer", now = NOW): Promise<readonly Outgoing[]> =>
  receive(bucket, from, JSON.stringify(["EVENT", event]), now)

const answer = async (bucket: Bucket, event: NostrEvent, now = NOW): Promise<readonly [boolean, string] | undefined> => {
  const out = (await sendEvent(bucket, event, "writer", now)).find((message) => message.to === "writer" && message.message[0] === "OK")
  return out?.message[0] === "OK" ? [out.message[2], out.message[3]] : undefined
}

const subscribe = (bucket: Bucket, socket: string, id: string, ...filters: readonly object[]): Promise<readonly Outgoing[]> =>
  receive(bucket, socket, JSON.stringify(["REQ", id, ...filters]), NOW)

const given = (outgoing: readonly Outgoing[], socket: string): readonly string[] =>
  outgoing.flatMap((out) => (out.to === socket && out.message[0] === "EVENT" ? [out.message[2].id] : []))

const ACCEPTED = [true, ""] as const

const spilledRows = (bucket: Bucket): number => Number(bucket.sql.run("SELECT count(*) AS n FROM subscriptions")[0]?.n ?? 0)

const senderOf = (by: Writer, seed: number) => ({ role: "sender" as const, pubkey: by.pubkey, mailbox: opaque(seed) })

describe("a bucket", () => {
  test("answers, keeps, and gives what it keeps before EOSE", async () => {
    const bucket = bucketOf("open")
    const change = bookChange(owner)
    expect(await answer(bucket, change)).toEqual(ACCEPTED)
    expect(await answer(bucket, change)).toEqual([true, "duplicate: already have this event"])
    const found = await subscribe(bucket, "reader", "s", { "#v": [opaque(1)] })
    expect(found.map((out) => out.message[0])).toEqual(["EVENT", "EOSE"])
    expect(given(found, "reader")).toEqual([change.id])
  })

  test("gives a live event to the subscriptions it matches, on its line or naming none", async () => {
    const bucket = bucketOf("open")
    await subscribe(bucket, "same-line", "a", { "#v": [opaque(1)] })
    await subscribe(bucket, "other-line", "b", { "#v": [opaque(2)] })
    await subscribe(bucket, "any-line", "c", { authors: [owner.pubkey] })
    const change = bookChange(owner)
    const out = await sendEvent(bucket, change)
    expect(given(out, "same-line")).toEqual([change.id])
    expect(given(out, "other-line")).toEqual([])
    expect(given(out, "any-line")).toEqual([change.id])
  })

  test("stops giving after CLOSE and once a socket leaves", async () => {
    const bucket = bucketOf("open")
    await subscribe(bucket, "closing", "s", {})
    await subscribe(bucket, "leaving", "s", {})
    await receive(bucket, "closing", JSON.stringify(["CLOSE", "s"]), NOW)
    leave(bucket, "leaving")
    const out = await sendEvent(bucket, bookChange(owner))
    expect(out.filter((message) => message.message[0] === "EVENT")).toEqual([])
  })

  test("keeps no subscription in SQLite while its socket carries it, and is given it back by what the open sockets carried on waking", async () => {
    const carried = new Map<string, Carried>()
    const holding: Holding = { carry: (socket, subscriptions) => (carried.set(socket, subscriptions), true), due: () => undefined }
    const slept = bucketOf("open", {}, holding)
    await subscribe(slept, "stayed", "s", { "#v": [opaque(1)] })
    await subscribe(slept, "went", "s", {})
    expect(spilledRows(slept)).toBe(0)
    const woken: Bucket = { ...slept, held: { sockets: new Map(), spilled: new Set(), subscriptions: undefined } }
    wake(woken, [{ socket: "stayed", carried: carried.get("stayed") }])
    const out = await sendEvent(woken, bookChange(owner))
    expect(out.flatMap((message) => (message.message[0] === "EVENT" ? [message.to] : []))).toEqual(["stayed"])
  })

  test("spills what a socket cannot carry, gives it back on waking, and forgets it once the socket goes or carries it again", async () => {
    const roomy = { fits: false }
    const holding: Holding = { carry: () => roomy.fits, due: () => undefined }
    const slept = bucketOf("open", {}, holding)
    await subscribe(slept, "large", "s", {})
    await subscribe(slept, "went", "s", {})
    expect(spilledRows(slept)).toBe(2)
    const woken: Bucket = { ...slept, held: { sockets: new Map(), spilled: new Set(), subscriptions: undefined } }
    wake(woken, [{ socket: "large", carried: [] }])
    expect(spilledRows(woken)).toBe(1)
    expect(given(await sendEvent(woken, bookChange(owner)), "large")).toHaveLength(1)
    roomy.fits = true
    await subscribe(woken, "large", "t", {})
    expect(spilledRows(woken)).toBe(0)
    roomy.fits = false
    await subscribe(woken, "large", "u", {})
    leave(woken, "large")
    expect(spilledRows(woken)).toBe(0)
  })

  test("leaves out on waking whatever a socket carried that does not read", () => {
    const bucket = bucketOf("open")
    wake(bucket, [{ socket: "odd", carried: [{ id: "s", filters: [{ kinds: "x" }] }, { id: 1 }, "s"] }, { socket: "none", carried: undefined }])
    expect(bucket.held.sockets.size).toBe(0)
  })

  test("holds a socket to its subscriptions and a subscription to its filters", async () => {
    const bucket = bucketOf("open", { mostSubscriptions: 2, mostFilters: 2 })
    await subscribe(bucket, "reader", "a", {})
    await subscribe(bucket, "reader", "b", {})
    expect((await subscribe(bucket, "reader", "a", { kinds: [1] })).at(-1)?.message).toEqual(["EOSE", "a"])
    expect((await subscribe(bucket, "reader", "c", {})).at(-1)?.message).toEqual(["CLOSED", "c", "restricted: too many subscriptions"])
    expect((await subscribe(bucket, "other", "d", {}, {}, {})).at(-1)?.message).toEqual(["CLOSED", "d", "restricted: too many filters"])
  })

  test("refuses what is not P-Lens's, and what is too large or too far ahead", async () => {
    const bucket = bucketOf("open")
    expect(await answer(bucket, signed(owner, { kind: 1, created_at: NOW, tags: [], content: "hello" }))).toEqual([false, "blocked: kind 1 is not P-Lens's"])
    expect(await answer(bucket, bookChange(owner, opaque(1), NOW + 3_600))).toEqual([false, "invalid: created_at too far ahead"])
    const large = signed(owner, { kind: KIND.bookChange, created_at: NOW, tags: [["v", opaque(1)]], content: "A".repeat(70_000) })
    expect(await answer(bucket, large)).toEqual([false, "invalid: event too large"])
  })

  test("answers what it cannot read", async () => {
    const bucket = bucketOf("open")
    expect(await receive(bucket, "c", "not json", NOW)).toEqual([{ to: "c", message: ["NOTICE", "invalid: not a JSON array"] }])
    expect(await receive(bucket, "c", JSON.stringify(["REQ", "s", { kinds: "x" }]), NOW)).toEqual([{ to: "c", message: ["CLOSED", "s", "invalid: filter"] }])
  })
})

describe("a capped bucket's access lists", () => {
  test("let a sender send while listed, and not once the list leaves them out or is deleted", async () => {
    const bucket = bucketOf("capped")
    const list = accessList(owner, "sending", [senderOf(sender, 20)])
    expect(await answer(bucket, list)).toEqual(ACCEPTED)
    expect(await answer(bucket, sentPlay(sender, opaque(30)))).toEqual(ACCEPTED)
    expect(await answer(bucket, mailbox(owner, opaque(20)))).toEqual(ACCEPTED)
    const without = accessList(owner, "sending", [senderOf(stranger, 21)], opaque(10), NOW + 1)
    expect(await answer(bucket, without)).toEqual(ACCEPTED)
    expect(await answer(bucket, sentPlay(sender, opaque(31)))).toEqual([false, "restricted: not on the access list"])
    expect(await answer(bucket, sentPlay(stranger, opaque(32)))).toEqual(ACCEPTED)
    expect(await answer(bucket, deletion(owner, without))).toEqual(ACCEPTED)
    expect(await answer(bucket, sentPlay(stranger, opaque(33)))).toEqual([false, "restricted: not on the access list"])
  })

  test("count a huddle's participants from what the bucket keeps", async () => {
    const bucket = bucketOf("capped", {})
    const people = Array.from({ length: 30 }, (_, n) => writer(100 + n))
    const answers = await Promise.all(people.map(async (person) => answer(bucket, huddleState(person))))
    expect(answers.every((one) => one?.[0] === true)).toBe(true)
    expect(await answer(bucket, huddleState(writer(200)))).toEqual([false, "restricted: full"])
  })
})

describe("a gated bucket", () => {
  test("keeps a ticket's grant, spends it once, and lets the book's line be written", async () => {
    const bucket = bucketOf("gated")
    expect(await answer(bucket, bookChange(owner))).toEqual([false, "restricted: pass-required for sync"])
    expect(await answer(bucket, redemption(owner, "sync:1:2026-11:k1"))).toEqual(ACCEPTED)
    expect(await answer(bucket, redemption(stranger, "sync:1:2026-11:k1"))).toEqual([false, "invalid: ticket already redeemed"])
    expect(await answer(bucket, bookChange(owner))).toEqual(ACCEPTED)
    expect(await answer(bucket, playCopy(owner))).toEqual(ACCEPTED)
  })

  test("holds the largest cap granted for now", async () => {
    const bucket = bucketOf("gated")
    await answer(bucket, redemption(owner, "sharing:2:2026-11:k1"))
    await answer(bucket, redemption(owner, "sharing:5:2026-11:k2"))
    const viewers = Array.from({ length: 5 }, (_, n) => ({ role: "viewer" as const, mailbox: opaque(50 + n) }))
    expect(await answer(bucket, accessList(owner, "sharing", viewers))).toEqual(ACCEPTED)
  })
})

describe("pruning", () => {
  test("takes out what has run out, with what was kept beside it", async () => {
    const bucket = bucketOf("capped")
    const listing = accessList(owner, "sending", [senderOf(sender, 20)])
    await answer(bucket, listing)
    const copy = playCopy(owner)
    await answer(bucket, copy)
    expect(prune(bucket.sql, Number(EXPIRY))).toBe(1)
    expect(given(await subscribe(bucket, "reader", "s", {}), "reader")).toEqual([listing.id])
    expect(await answer(bucket, sentPlay(sender, opaque(40)))).toEqual(ACCEPTED)
  })

  test("says when what it keeps runs out, and when a deletion is forgotten", async () => {
    const dues: number[] = []
    const bucket = bucketOf("open", {}, { carry: () => true, due: (at) => void dues.push(at) })
    expect(dueOf(bucket.sql)).toBeUndefined()
    const copy = playCopy(owner)
    await answer(bucket, copy)
    await answer(bucket, bookChange(owner))
    expect(dues).toEqual([Number(EXPIRY)])
    expect(dueOf(bucket.sql)).toBe(Number(EXPIRY))
    const removal = deletion(owner, copy)
    await answer(bucket, removal)
    const forgotten = removal.created_at + 400 * 86_400 + 1
    expect(dues).toEqual([Number(EXPIRY), forgotten])
    expect(dueOf(bucket.sql)).toBe(forgotten)
    prune(bucket.sql, forgotten)
    expect(dueOf(bucket.sql)).toBeUndefined()
  })
})
