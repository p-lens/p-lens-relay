import { describe, expect, test } from "bun:test"
import { admit, emptyStore, kindClass, query, type DefaultLimit, type NostrEvent, type Store, type Tie } from "../src"
import { signed, writer } from "../src/testing"

const alice = writer(1)
const bob = writer(2)
const NEWEST: DefaultLimit = { order: "newest", count: 500 }

const storeOf = (tie: Tie, events: readonly NostrEvent[]): Store => events.reduce((store, event) => admit(tie, store, event).store, emptyStore)

const ids = (events: readonly NostrEvent[]): readonly string[] => events.map((event) => event.id)

describe("kinds", () => {
  test.each([
    [1, "regular"],
    [4738, "regular"],
    [0, "replaceable"],
    [10_002, "replaceable"],
    [24_739, "ephemeral"],
    [34_739, "addressable"],
  ] as const)("%d is %s", (kind, expected) => {
    expect(kindClass(kind)).toBe(expected)
  })
})

describe("admitting", () => {
  test("keeps regular events and knows a repeat", () => {
    const event = signed(alice, { kind: 4738, created_at: 100, tags: [["v", "a"]] })
    const once = admit("lowest-id", emptyStore, event)
    expect(once.admission).toEqual({ type: "stored", replaced: undefined })
    expect(admit("lowest-id", once.store, event).admission).toEqual({ type: "duplicate" })
  })

  test("passes ephemeral events without keeping them", () => {
    const pulse = signed(alice, { kind: 24_739, created_at: 100 })
    const result = admit("lowest-id", emptyStore, pulse)
    expect(result.admission).toEqual({ type: "passed" })
    expect(result.store.events).toEqual([])
  })

  test("keeps the latest version of an address, refusing an older one", () => {
    const first = signed(alice, { kind: 34_739, created_at: 100, tags: [["d", "x"]], content: "1" })
    const second = signed(alice, { kind: 34_739, created_at: 101, tags: [["d", "x"]], content: "2" })
    const held = admit("lowest-id", admit("lowest-id", emptyStore, first).store, second)
    expect(held.admission).toEqual({ type: "stored", replaced: first })
    expect(admit("lowest-id", held.store, first).admission).toEqual({ type: "have-newer" })
    const older = signed(alice, { kind: 34_739, created_at: 99, tags: [["d", "x"]], content: "0" })
    expect(admit("lowest-id", held.store, older).admission).toEqual({ type: "have-newer" })
  })

  test("keeps addresses apart by author and by d", () => {
    const events = [
      signed(alice, { kind: 34_739, created_at: 100, tags: [["d", "x"]] }),
      signed(alice, { kind: 34_739, created_at: 100, tags: [["d", "y"]] }),
      signed(bob, { kind: 34_739, created_at: 100, tags: [["d", "x"]] }),
    ]
    expect(storeOf("lowest-id", events).events).toHaveLength(3)
  })

  const tied = [0, 1, 2, 3].map((n) => signed(alice, { kind: 34_739, created_at: 100, tags: [["d", "x"]], content: String(n) }))
  const [lower, higher] = [...tied].sort((a, b) => (a.id < b.id ? -1 : 1)) as [NostrEvent, NostrEvent, ...NostrEvent[]]

  test.each([
    ["lowest-id", [higher, lower], lower],
    ["lowest-id", [lower, higher], lower],
    ["first-arrival", [higher, lower], higher],
    ["first-arrival", [lower, higher], lower],
  ] as const)("in one second, %s keeps the one it should", (tie, order, kept) => {
    expect(storeOf(tie, order).events).toEqual([kept])
  })

  test("deletes an author's own events and never takes them again", () => {
    const event = signed(alice, { kind: 4738, created_at: 100 })
    const deletion = signed(alice, { kind: 5, created_at: 101, tags: [["e", event.id]] })
    const after = storeOf("lowest-id", [event, deletion])
    expect(ids(after.events)).toEqual([deletion.id])
    expect(admit("lowest-id", after, event).admission).toEqual({ type: "deleted" })
  })

  test("never deletes another author's events", () => {
    const event = signed(alice, { kind: 4738, created_at: 100 })
    const deletion = signed(bob, { kind: 5, created_at: 101, tags: [["e", event.id]] })
    const after = storeOf("lowest-id", [event, deletion])
    expect(ids(after.events)).toContain(event.id)
    expect(admit("lowest-id", after, event).admission).toEqual({ type: "duplicate" })
  })
})

describe("querying", () => {
  const lineA = [100, 101, 102].map((at) => signed(alice, { kind: 4738, created_at: at, tags: [["v", "a"]] }))
  const lineB = [signed(bob, { kind: 4738, created_at: 103, tags: [["v", "b"]] })]
  const store = storeOf("lowest-id", [...lineA, ...lineB])

  test("finds by tag, author, kind and time, newest first", () => {
    expect(ids(query(store, [{ "#v": ["a"] }], NEWEST, 500, 0))).toEqual(ids([...lineA].reverse()))
    expect(ids(query(store, [{ authors: [bob.pubkey] }], NEWEST, 500, 0))).toEqual(ids(lineB))
    expect(ids(query(store, [{ kinds: [4739] }], NEWEST, 500, 0))).toEqual([])
    expect(ids(query(store, [{ "#v": ["a"], since: 101, until: 101 }], NEWEST, 500, 0))).toEqual(ids(lineA.slice(1, 2)))
  })

  test("limits each filter, up to the relay's most", () => {
    expect(ids(query(store, [{ "#v": ["a"], limit: 2 }], NEWEST, 500, 0))).toEqual(ids([lineA[2], lineA[1]] as NostrEvent[]))
    expect(query(store, [{ limit: 10 }], NEWEST, 3, 0)).toHaveLength(3)
  })

  test("gives a filter without a limit what the relay's default says", () => {
    expect(query(store, [{}], { order: "newest", count: 2 }, 500, 0)).toHaveLength(2)
    expect(ids(query(store, [{ "#v": ["a"] }], { order: "oldest-all" }, 500, 0))).toEqual(ids(lineA))
  })

  test("joins filters without repeats", () => {
    expect(query(store, [{ "#v": ["a"] }, { authors: [alice.pubkey] }], NEWEST, 500, 0)).toHaveLength(3)
  })

  test("leaves out what has expired", () => {
    const expiring = signed(alice, { kind: 4739, created_at: 100, tags: [["expiration", "200"]] })
    const held = storeOf("lowest-id", [expiring])
    expect(query(held, [{}], NEWEST, 500, 199)).toHaveLength(1)
    expect(query(held, [{}], NEWEST, 500, 200)).toHaveLength(0)
  })
})
