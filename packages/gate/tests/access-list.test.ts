import { describe, expect, test } from "bun:test"
import { accessListOf } from "../src/access-list"
import { opaque } from "../src/testing"

const pubkey = "a".repeat(64)
const listed = (value: unknown): string => JSON.stringify(value)

describe("an access list", () => {
  test("is read with editors and viewers for sharing, senders for sending", () => {
    const sharing = {
      product: "sharing",
      members: [
        { role: "editor", pubkey, mailbox: opaque(1) },
        { role: "viewer", mailbox: opaque(2) },
      ],
      stamp: 3,
    }
    expect(accessListOf(listed(sharing))).toEqual(sharing as never)
    const sending = { product: "sending", members: [{ role: "sender", pubkey, mailbox: opaque(1) }], stamp: 0 }
    expect(accessListOf(listed(sending))).toEqual(sending as never)
  })

  test.each([
    ["a name beside a member", { product: "sharing", members: [{ role: "viewer", mailbox: opaque(1), name: "ルパン" }], stamp: 1 }],
    ["a note beside the members", { product: "sharing", members: [], stamp: 1, note: "軍団" }],
    ["a sender among those shared with", { product: "sharing", members: [{ role: "sender", pubkey, mailbox: opaque(1) }], stamp: 1 }],
    ["an editor among senders", { product: "sending", members: [{ role: "editor", pubkey, mailbox: opaque(1) }], stamp: 1 }],
    ["a viewer with a key", { product: "sharing", members: [{ role: "viewer", pubkey, mailbox: opaque(1) }], stamp: 1 }],
    ["an editor without a key", { product: "sharing", members: [{ role: "editor", mailbox: opaque(1) }], stamp: 1 }],
    ["one mailbox twice", { product: "sharing", members: [{ role: "viewer", mailbox: opaque(1) }, { role: "viewer", mailbox: opaque(1) }], stamp: 1 }],
    [
      "one key twice",
      { product: "sending", members: [{ role: "sender", pubkey, mailbox: opaque(1) }, { role: "sender", pubkey, mailbox: opaque(2) }], stamp: 1 },
    ],
    ["a mailbox that is no locator", { product: "sharing", members: [{ role: "viewer", mailbox: "mine" }], stamp: 1 }],
    ["a product not listed", { product: "sync", members: [], stamp: 1 }],
    ["no stamp", { product: "sharing", members: [] }],
    ["a stamp below nothing", { product: "sharing", members: [], stamp: -1 }],
  ])("refuses %s", (_, value) => {
    expect(accessListOf(listed(value))).toBeUndefined()
  })

  test("refuses what is not JSON", () => {
    expect(accessListOf("not json")).toBeUndefined()
  })
})
