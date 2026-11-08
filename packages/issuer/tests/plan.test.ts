import type { TicketInfo } from "@p-lens-relay/tickets"
import { describe, expect, test } from "bun:test"
import { issueRefusal, MOST_AT_ONCE, openPeriods, planOf, type Plan } from "../src/plan"

/** 2026-11-15 00:00 UTC. */
const MID_NOVEMBER = Date.UTC(2026, 10, 15) / 1000
/** 2026-11-25 00:00 UTC: inside November's last week. */
const LATE_NOVEMBER = Date.UTC(2026, 10, 25) / 1000

const PLAN: Plan = {
  items: [
    { product: "sync", cap: 1, perMonth: 3 },
    { product: "huddles", cap: 10, perMonth: 8 },
  ],
  starts: "2026-10",
  ends: "2027-01",
}

const sync = (period = "2026-11"): TicketInfo => ({ product: "sync", cap: 1, period })
const none = () => 0

describe("the months tickets are asked for", () => {
  test("are this one, and the next in this one's last week", () => {
    expect(openPeriods(MID_NOVEMBER)).toEqual(["2026-11"])
    expect(openPeriods(LATE_NOVEMBER)).toEqual(["2026-11", "2026-12"])
    expect(openPeriods(Date.UTC(2026, 11, 28) / 1000)).toEqual(["2026-12", "2027-01"])
  })
})

describe("issuing on a plan", () => {
  test("gives what the plan has left", () => {
    expect(issueRefusal(PLAN, none, [sync(), sync(), sync()], MID_NOVEMBER)).toBeUndefined()
    expect(issueRefusal(PLAN, () => 2, [sync()], MID_NOVEMBER)).toBeUndefined()
  })

  test("counts what was issued already, and says how many are left", () => {
    expect(issueRefusal(PLAN, () => 2, [sync(), sync()], MID_NOVEMBER)).toEqual({ type: "too-many", product: "sync", cap: 1, period: "2026-11", left: 1 })
  })

  test("refuses a product, or a cap, the plan does not have", () => {
    expect(issueRefusal(PLAN, none, [{ product: "sharing", cap: 5, period: "2026-11" }], MID_NOVEMBER)).toEqual({ type: "not-in-plan", product: "sharing", cap: 5 })
    expect(issueRefusal(PLAN, none, [{ product: "huddles", cap: 30, period: "2026-11" }], MID_NOVEMBER)).toEqual({ type: "not-in-plan", product: "huddles", cap: 30 })
  })

  test("gives next month's only in this one's last week", () => {
    expect(issueRefusal(PLAN, none, [sync("2026-12")], MID_NOVEMBER)).toEqual({ type: "wrong-period", period: "2026-12" })
    expect(issueRefusal(PLAN, none, [sync("2026-12")], LATE_NOVEMBER)).toBeUndefined()
    expect(issueRefusal(PLAN, none, [sync("2026-10")], MID_NOVEMBER)).toEqual({ type: "wrong-period", period: "2026-10" })
  })

  test("refuses months the plan does not hold", () => {
    expect(issueRefusal({ ...PLAN, starts: "2026-12" }, none, [sync()], MID_NOVEMBER)).toEqual({ type: "plan-not-started", starts: "2026-12" })
    expect(issueRefusal({ ...PLAN, ends: "2026-11" }, none, [sync()], MID_NOVEMBER)).toEqual({ type: "plan-over", ended: "2026-11" })
  })

  test("refuses no plan, nothing asked, and too much at once", () => {
    expect(issueRefusal(undefined, none, [sync()], MID_NOVEMBER)).toEqual({ type: "unknown-plan" })
    expect(issueRefusal(PLAN, none, [], MID_NOVEMBER)).toEqual({ type: "malformed" })
    expect(issueRefusal(PLAN, none, Array.from({ length: MOST_AT_ONCE + 1 }, () => sync()), MID_NOVEMBER)).toEqual({ type: "too-many-at-once" })
  })
})

describe("a plan as stated", () => {
  test("ends after its months", () => {
    expect(planOf({ items: [{ product: "sync", cap: 1, perMonth: 2 }], starts: "2026-11", months: 12 })).toEqual({
      items: [{ product: "sync", cap: 1, perMonth: 2 }],
      starts: "2026-11",
      ends: "2027-11",
    })
  })

  test.each([
    ["a sync cap other than one book", { items: [{ product: "sync", cap: 2, perMonth: 1 }], starts: "2026-11", months: 1 }],
    ["a huddle of more than thirty", { items: [{ product: "huddles", cap: 31, perMonth: 1 }], starts: "2026-11", months: 1 }],
    ["sharing with more than thirty", { items: [{ product: "sharing", cap: 31, perMonth: 1 }], starts: "2026-11", months: 1 }],
    ["one item twice", { items: [{ product: "sync", cap: 1, perMonth: 1 }, { product: "sync", cap: 1, perMonth: 2 }], starts: "2026-11", months: 1 }],
    ["no items", { items: [], starts: "2026-11", months: 1 }],
    ["a field beside an item's", { items: [{ product: "sync", cap: 1, perMonth: 1, buyer: "someone" }], starts: "2026-11", months: 1 }],
    ["no months", { items: [{ product: "sync", cap: 1, perMonth: 1 }], starts: "2026-11", months: 0 }],
    ["a month that is no month", { items: [{ product: "sync", cap: 1, perMonth: 1 }], starts: "2026-13", months: 1 }],
  ])("is refused with %s", (_, stated) => {
    expect(planOf(stated)).toBeUndefined()
  })

  test("may send to more than two hundred, by arrangement", () => {
    expect(planOf({ items: [{ product: "sending", cap: 500, perMonth: 1 }], starts: "2026-11", months: 1 })).toBeDefined()
  })
})
