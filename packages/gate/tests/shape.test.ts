import type { NostrEvent } from "@p-lens-relay/core"
import { signed, writer } from "@p-lens-relay/core/testing"
import { describe, expect, test } from "bun:test"
import { sealBytes, sealJson } from "@p-lens-relay/reference/seal"
import { looksSealed, shapeFault } from "../src/shape"
import { KIND } from "../src"
import { accessList, bookChange, EXPIRY, huddleState, mailbox, NOW, opaque, playCopy, redemption, sealedContent, sentPlay } from "../src/testing"

const alice = writer(1)

const event = (kind: number, tags: readonly (readonly string[])[], content = sealedContent()): NostrEvent =>
  signed(alice, { kind, created_at: NOW, tags, content })

describe("the shape every P-Lens relay holds events to", () => {
  test.each([
    ["a book's change", bookChange(alice)],
    ["a tip", event(KIND.tip, [["v", opaque(1)], ["d", opaque(2)]])],
    ["an access list", accessList(alice, "sharing", [])],
    ["a mailbox", mailbox(alice, opaque(3))],
    ["a play's copy", playCopy(alice)],
    ["a sent play", sentPlay(alice)],
    ["a huddle's state", huddleState(alice)],
    ["a redemption", redemption(alice, "ticket")],
    ["a deletion", event(KIND.deletion, [["e", "f".repeat(64)], ["k", "4738"]], "")],
    ["the largest seal", event(KIND.bookChange, [["v", opaque(1)]], sealedContent(32_768))],
  ])("takes %s", (_, held) => {
    expect(shapeFault(held)).toBeUndefined()
  })

  test.each([1, 0, 30_078, 10_002, 4737])("refuses kind %d, which is not P-Lens's", (kind) => {
    expect(shapeFault(event(kind, [["v", opaque(1)]]))).toEqual({ type: "foreign-kind", kind })
  })

  test.each([
    ["a tag P-Lens never writes", [["v", opaque(1)], ["p", "f".repeat(64)]]],
    ["no line", []],
    ["two lines", [["v", opaque(1)], ["v", opaque(2)]]],
    ["a line that is no locator", [["v", "book-1"]]],
    ["a line in upper case", [["v", opaque(10).toUpperCase()]]],
    ["a tag with a third part", [["v", opaque(1), "wss://relay"]]],
    ["an address on a regular kind", [["v", opaque(1)], ["d", opaque(2)]]],
  ])("refuses a change with %s", (_, tags) => {
    expect(shapeFault(event(KIND.bookChange, tags))).toEqual({ type: "wrong-tags" })
  })

  test("refuses an addressable event without its address, and a copy without its expiry", () => {
    expect(shapeFault(event(KIND.tip, [["v", opaque(1)]]))).toEqual({ type: "wrong-tags" })
    expect(shapeFault(event(KIND.playCopy, [["v", opaque(1)], ["d", opaque(2)]]))).toEqual({ type: "wrong-tags" })
  })

  test("refuses an expiry that is not a whole day, which would tell the hour a business day turns", () => {
    const tags = [["v", opaque(1)], ["d", opaque(2)], ["expiration", String(Number(EXPIRY) + 5 * 3600)]]
    expect(shapeFault(event(KIND.playCopy, tags))).toEqual({ type: "unrounded-expiration" })
  })

  test.each([
    ["plain text", "パチンコ ネルフ 第3新東京店 +12,345"],
    ["JSON", JSON.stringify({ parlor: "パチンコ ネルフ" })],
    ["base64 of another version", Buffer.from(new Uint8Array(63).fill(2)).toString("base64")],
    ["a plaintext of no padded length", sealedContent(33)],
    ["a plaintext larger than a seal carries", sealedContent(36_864)],
    ["nothing", ""],
  ])("refuses content that is %s, where a seal belongs", (_, content) => {
    expect(shapeFault(event(KIND.bookChange, [["v", opaque(1)]], content))).toEqual({ type: "unsealed-content" })
  })

  test("refuses a deletion giving a reason or naming a line, and a redemption with content", () => {
    expect(shapeFault(event(KIND.deletion, [["e", "f".repeat(64)]], "moved to my own relay"))).toEqual({ type: "wrong-tags" })
    expect(shapeFault(event(KIND.deletion, [["e", "f".repeat(64)], ["v", opaque(1)]], ""))).toEqual({ type: "wrong-tags" })
    expect(shapeFault(event(KIND.redemption, [["v", opaque(1)], ["claim", "t"]], "hello"))).toEqual({ type: "unsealed-content" })
  })
})

describe("a seal made as PROTOCOL.md says", () => {
  const key = new Uint8Array(32).fill(1)
  const nonce = new Uint8Array(12).fill(2)
  const place = { kind: KIND.playCopy, v: opaque(1), d: opaque(2), pubkey: alice.pubkey }

  test.each([1, 33, 257, 4_097, 31_999, 32_000])("looks sealed to the relay with %d bytes inside", async (length) => {
    const sealed = await sealBytes(key, nonce, place, new Uint8Array(length).fill(3))
    expect(sealed.ok && looksSealed(sealed.value)).toBe(true)
  })

  test("looks sealed with a play inside", async () => {
    const sealed = await sealJson(key, nonce, place, { parlor: "パチンコ ネルフ 第3新東京店", tokens: 12_345 })
    expect(sealed.ok && looksSealed(sealed.value)).toBe(true)
  })
})
