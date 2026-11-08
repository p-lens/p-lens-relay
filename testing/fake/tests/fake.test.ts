import type { NostrEvent, Outgoing } from "@p-lens-relay/core"
import { signed, writer } from "@p-lens-relay/core/testing"
import { describe, expect, test } from "bun:test"
import { emptyFake, fakeStep, PLAIN, PRESETS, type FakeState, type Quirks } from "../src"

const alice = writer(1)

type Run = { readonly state: FakeState; readonly outgoing: readonly Outgoing[] }

const run = (quirks: Quirks, messages: readonly (readonly [string, unknown, number?])[], from?: FakeState): Run =>
  messages.reduce<Run>(
    (sofar, [connection, message, now]) => {
      const next = fakeStep(quirks, sofar.state, connection, JSON.stringify(message), now ?? 1_000)
      return { state: next.state, outgoing: [...sofar.outgoing, ...next.outgoing] }
    },
    { state: from ?? emptyFake(quirks), outgoing: [] },
  )

const given = (outgoing: readonly Outgoing[], connection: string): readonly string[] =>
  outgoing.flatMap((out) => (out.to === connection && out.message[0] === "EVENT" ? [out.message[2].content] : []))

const regular = (n: number): NostrEvent => signed(alice, { kind: 4738, created_at: 900 + n, tags: [["v", "a"]], content: String(n) })

const version = (n: number, at = 900 + n): NostrEvent =>
  signed(alice, { kind: 34_739, created_at: at, tags: [["v", "a"], ["d", "x"]], content: `v${n}` })

const writes = (events: readonly NostrEvent[]) => events.map((event) => ["writer", ["EVENT", event]] as const)

describe("a plain fake", () => {
  test("is the relay core", () => {
    const { outgoing } = run(PLAIN, [...writes([regular(1), regular(2)]), ["reader", ["REQ", "s", { "#v": ["a"] }]]])
    expect(given(outgoing, "reader")).toEqual(["2", "1"])
    expect(outgoing.filter((out) => out.to === "writer").map((out) => out.message[0])).toEqual(["OK", "OK"])
  })
})

describe("quirks", () => {
  test("dropping answers OK and keeps nothing", () => {
    const { outgoing } = run({ ...PLAIN, drops: 1 }, [...writes([regular(1)]), ["reader", ["REQ", "s", {}]]])
    expect(outgoing.find((out) => out.to === "writer")?.message).toEqual(["OK", regular(1).id, true, ""])
    expect(given(outgoing, "reader")).toEqual([])
  })

  test("dropping ephemeral events passes none on", () => {
    const pulse = signed(alice, { kind: 24_739, created_at: 990, tags: [["v", "a"]], content: "pulse" })
    const { outgoing } = run({ ...PLAIN, dropsEphemeral: true }, [["reader", ["REQ", "s", {}]], ...writes([pulse])])
    expect(given(outgoing, "reader")).toEqual([])
  })

  test("withholding OK answers nothing", () => {
    const { outgoing } = run({ ...PLAIN, withholdsOk: true }, writes([regular(1)]))
    expect(outgoing).toEqual([])
  })

  test("reordering gives the same events in another order", () => {
    const events = Array.from({ length: 20 }, (_, n) => regular(n))
    const { outgoing } = run({ ...PLAIN, reorders: true }, [...writes(events), ["reader", ["REQ", "s", {}]]])
    const order = given(outgoing, "reader")
    expect([...order].sort()).toEqual(events.map((event) => event.content).sort())
    expect(order).not.toEqual(events.map((event) => event.content).reverse())
  })

  test("repeating gives events twice", () => {
    const { outgoing } = run({ ...PLAIN, repeats: 1 }, [...writes([regular(1)]), ["reader", ["REQ", "s", {}]]])
    expect(given(outgoing, "reader")).toEqual(["1", "1"])
  })

  test("a stale cache gives the same filters what they found before, until it ages", () => {
    const quirks = { ...PLAIN, staleCacheSeconds: 60 }
    const { outgoing } = run(quirks, [
      ["writer", ["EVENT", regular(1)], 1_000],
      ["first", ["REQ", "s", {}], 1_000],
      ["writer", ["EVENT", regular(2)], 1_010],
      ["cached", ["REQ", "s", {}], 1_010],
      ["fresh", ["REQ", "s", {}], 1_060],
    ])
    expect(given(outgoing, "cached")).toEqual(["1"])
    expect(given(outgoing, "fresh")).toEqual(["2", "1"])
  })

  test("old versions come back in place of what replaced them", () => {
    const { outgoing } = run({ ...PLAIN, oldVersions: 1 }, [...writes([version(1), version(2)]), ["reader", ["REQ", "s", {}]]])
    expect(given(outgoing, "reader")).toEqual(["v1"])
  })
})

describe("presets", () => {
  const tied = [1, 2, 3, 4].map((n) => version(n, 950))
  const sorted = [...tied].sort((a, b) => (a.id < b.id ? -1 : 1))
  const lower = sorted[0] as NostrEvent
  const higher = sorted[sorted.length - 1] as NostrEvent

  test("nosflare keeps the first of a second, whatever its id", () => {
    const { outgoing } = run(PRESETS.nosflare, [...writes([higher, lower]), ["reader", ["REQ", "s", {}]]])
    expect(given(outgoing, "reader")).toEqual([higher.content])
  })

  test("nostr-rs-relay keeps the first of a second, as found by conformance", () => {
    const { outgoing } = run(PRESETS["nostr-rs-relay"], [...writes([higher, lower]), ["reader", ["REQ", "s", {}]]])
    expect(given(outgoing, "reader")).toEqual([higher.content])
  })

  test("strfry keeps the lowest id", () => {
    const { outgoing } = run(PRESETS.strfry, [...writes([higher, lower]), ["reader", ["REQ", "s", {}]]])
    expect(given(outgoing, "reader")).toEqual([lower.content])
  })

  test("a quirky run happens the same way every time", () => {
    const messages = [...writes(Array.from({ length: 30 }, (_, n) => regular(n))), ["reader", ["REQ", "s", {}]] as const]
    expect(run(PRESETS.chaos, messages).outgoing).toEqual(run(PRESETS.chaos, messages).outgoing)
  })
})
