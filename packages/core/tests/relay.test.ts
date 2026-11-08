import { describe, expect, test } from "bun:test"
import { disconnect, emptyRelay, invalidityOf, RULES, step, type Outgoing, type RelayState, type Rules } from "../src"
import { signed, writer } from "../src/testing"

const alice = writer(1)

type Run = { readonly state: RelayState; readonly outgoing: readonly Outgoing[] }

/** Sends messages in turn, gathering everything the relay sent. */
const run = (rules: Rules, messages: readonly (readonly [string, unknown])[], now = 1_000, from: RelayState = emptyRelay): Run =>
  messages.reduce<Run>(
    (sofar, [connection, message]) => {
      const next = step(rules, sofar.state, connection, JSON.stringify(message), now)
      return { state: next.state, outgoing: [...sofar.outgoing, ...next.outgoing] }
    },
    { state: from, outgoing: [] },
  )

const to = (outgoing: readonly Outgoing[], connection: string) => outgoing.filter((out) => out.to === connection).map((out) => out.message)

describe("validity", () => {
  const event = signed(alice, { kind: 4738, created_at: 100, content: "x" })

  test("takes a signed event", () => {
    expect(invalidityOf(event)).toBeUndefined()
  })

  test("refuses a changed content, a changed id and a bad shape", () => {
    expect(invalidityOf({ ...event, content: "y" })).toEqual({ type: "wrong-id" })
    expect(invalidityOf({ ...event, sig: "0".repeat(128) })).toEqual({ type: "bad-signature" })
    expect(invalidityOf({ ...event, kind: "4738" })).toEqual({ type: "malformed" })
  })
})

describe("a relay", () => {
  const event = signed(alice, { kind: 4738, created_at: 990, tags: [["v", "a"]] })

  test("answers an event with OK and gives it to a live subscription", () => {
    const { outgoing } = run(RULES, [
      ["reader", ["REQ", "s", { "#v": ["a"] }]],
      ["writer", ["EVENT", event]],
    ])
    expect(to(outgoing, "writer")).toEqual([["OK", event.id, true, ""]])
    expect(to(outgoing, "reader")).toEqual([["EOSE", "s"], ["EVENT", "s", event]])
  })

  test("gives stored events before EOSE", () => {
    const { outgoing } = run(RULES, [
      ["writer", ["EVENT", event]],
      ["reader", ["REQ", "s", { "#v": ["a"] }]],
    ])
    expect(to(outgoing, "reader")).toEqual([["EVENT", "s", event], ["EOSE", "s"]])
  })

  test("stops giving after CLOSE and after the connection goes", () => {
    const closed = run(RULES, [
      ["reader", ["REQ", "s", {}]],
      ["reader", ["CLOSE", "s"]],
      ["writer", ["EVENT", event]],
    ])
    expect(to(closed.outgoing, "reader")).toEqual([["EOSE", "s"]])
    const subscribed = run(RULES, [["reader", ["REQ", "s", {}]]])
    const gone = run(RULES, [["writer", ["EVENT", event]]], 1_000, disconnect(subscribed.state, "reader"))
    expect(to(gone.outgoing, "reader")).toEqual([])
  })

  test("passes an ephemeral event on without keeping it", () => {
    const pulse = signed(alice, { kind: 24_739, created_at: 990, tags: [["v", "a"]] })
    const live = run(RULES, [
      ["reader", ["REQ", "s", { "#v": ["a"] }]],
      ["writer", ["EVENT", pulse]],
      ["late", ["REQ", "t", { "#v": ["a"] }]],
    ])
    expect(to(live.outgoing, "reader")).toEqual([["EOSE", "s"], ["EVENT", "s", pulse]])
    expect(to(live.outgoing, "late")).toEqual([["EOSE", "t"]])
  })

  test("says why it refuses", () => {
    const tooFar = signed(alice, { kind: 4738, created_at: 1_000 + RULES.maxFutureSeconds + 1 })
    const large = signed(alice, { kind: 4738, created_at: 990, content: "x".repeat(RULES.maxEventBytes) })
    const { outgoing } = run(RULES, [
      ["writer", ["EVENT", tooFar]],
      ["writer", ["EVENT", large]],
      ["writer", ["EVENT", { ...event, content: "changed" }]],
    ])
    expect(to(outgoing, "writer")).toEqual([
      ["OK", tooFar.id, false, "invalid: created_at too far ahead"],
      ["OK", large.id, false, "invalid: event too large"],
      ["OK", event.id, false, "invalid: wrong-id"],
    ])
  })

  test("holds a connection to its rate", () => {
    const events = [0, 1, 2].map((n) => signed(alice, { kind: 4738, created_at: 990 + n }))
    const { outgoing } = run(
      { ...RULES, perMinute: 2 },
      events.map((sent) => ["writer", ["EVENT", sent]] as const),
    )
    expect(to(outgoing, "writer").map((message) => message[3])).toEqual(["", "", "rate-limited: slow down"])
  })

  test("refuses bad messages and filters", () => {
    const bad = step(RULES, emptyRelay, "c", "not json", 0)
    expect(bad.outgoing).toEqual([{ to: "c", message: ["NOTICE", "invalid: not a JSON array"] }])
    const filter = run(RULES, [["c", ["REQ", "s", { kinds: ["x"] }]]])
    expect(to(filter.outgoing, "c")).toEqual([["CLOSED", "s", "invalid: filter"]])
  })
})
