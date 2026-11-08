import { nextPeriod, periodOf, type TicketInfo, type TicketProduct } from "@p-lens-relay/tickets"

/** One product a plan pays for: at what cap, and how many tickets a month. */
export type PlanItem = { readonly product: TicketProduct; readonly cap: number; readonly perMonth: number }

/**
 * What a plan code buys, from the month it starts to the month it ends
 * before. A bundle is a plan of several items; the relay never sees one, only
 * the tickets each item gives.
 */
export type Plan = { readonly items: readonly PlanItem[]; readonly starts: string; readonly ends: string }

export type IssueRefusal =
  | { readonly type: "unknown-plan" }
  | { readonly type: "plan-not-started"; readonly starts: string }
  | { readonly type: "plan-over"; readonly ended: string }
  | { readonly type: "not-in-plan"; readonly product: TicketProduct; readonly cap: number }
  | { readonly type: "wrong-period"; readonly period: string }
  | { readonly type: "too-many"; readonly product: TicketProduct; readonly cap: number; readonly period: string; readonly left: number }
  | { readonly type: "too-many-at-once" }
  | { readonly type: "malformed" }

/** The most tickets one request asks for: a month of every item of a large plan fits. */
export const MOST_AT_ONCE = 64

/** How long before a month its tickets may be asked for: the relay takes them as early (`gate`'s AHEAD_SECONDS). */
const AHEAD_SECONDS = 7 * 86_400

/** The months tickets may be asked for now: this one, and the next in its last week. */
export const openPeriods = (now: number): readonly string[] => {
  const current = periodOf(now)
  return periodOf(now + AHEAD_SECONDS) === current ? [current] : [current, nextPeriod(current)]
}

/** How many tickets have been issued already for an item in a month. */
export type IssuedCount = (product: TicketProduct, cap: number, period: string) => number

const sameItem = (info: TicketInfo) => (item: PlanItem): boolean => item.product === info.product && item.cap === info.cap

const counted = (infos: readonly TicketInfo[]): ReadonlyMap<string, { readonly info: TicketInfo; readonly count: number }> =>
  infos.reduce((counts, info) => {
    const key = `${info.product}:${info.cap}:${info.period}`
    return new Map(counts).set(key, { info, count: (counts.get(key)?.count ?? 0) + 1 })
  }, new Map<string, { readonly info: TicketInfo; readonly count: number }>())

/**
 * Why tickets cannot be issued on a plan, if they cannot: the plan must hold
 * for each ticket's month, name its product at its cap, and have that many
 * left for the month.
 */
export const issueRefusal = (plan: Plan | undefined, issued: IssuedCount, infos: readonly TicketInfo[], now: number): IssueRefusal | undefined => {
  if (plan === undefined) return { type: "unknown-plan" }
  if (infos.length === 0) return { type: "malformed" }
  if (infos.length > MOST_AT_ONCE) return { type: "too-many-at-once" }
  const open = openPeriods(now)
  const wrong = infos.find((info) => !open.includes(info.period))
  if (wrong !== undefined) return { type: "wrong-period", period: wrong.period }
  const early = infos.find((info) => info.period < plan.starts)
  if (early !== undefined) return { type: "plan-not-started", starts: plan.starts }
  const late = infos.find((info) => info.period >= plan.ends)
  if (late !== undefined) return { type: "plan-over", ended: plan.ends }
  const outside = infos.find((info) => !plan.items.some(sameItem(info)))
  if (outside !== undefined) return { type: "not-in-plan", product: outside.product, cap: outside.cap }
  const over = [...counted(infos).values()].find(({ info, count }) => {
    const item = plan.items.find(sameItem(info))
    return item === undefined || issued(info.product, info.cap, info.period) + count > item.perMonth
  })
  if (over === undefined) return undefined
  const item = plan.items.find(sameItem(over.info))
  const left = Math.max(0, (item?.perMonth ?? 0) - issued(over.info.product, over.info.cap, over.info.period))
  return { type: "too-many", product: over.info.product, cap: over.info.cap, period: over.info.period, left }
}

/** The caps each product is sold at (PROTOCOL.md §9.4); sending beyond 200 by arrangement, so any cap is taken. */
const capHolds = (item: PlanItem): boolean => {
  switch (item.product) {
    case "sync":
      return item.cap === 1
    case "sharing":
      return item.cap >= 1 && item.cap <= 30
    case "sending":
      return item.cap >= 1
    case "huddles":
      return item.cap >= 2 && item.cap <= 30
  }
}

const PRODUCTS: readonly TicketProduct[] = ["sync", "sharing", "sending", "huddles"]

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/

const isItem = (value: unknown): value is PlanItem => {
  const item = value as Record<string, unknown> | null
  return (
    typeof item === "object" &&
    item !== null &&
    Object.keys(item).length === 3 &&
    PRODUCTS.includes(item.product as TicketProduct) &&
    Number.isSafeInteger(item.cap) &&
    Number.isSafeInteger(item.perMonth) &&
    (item.perMonth as number) >= 1 &&
    (item.perMonth as number) <= 1_000 &&
    capHolds(item as PlanItem)
  )
}

/** A plan as an operator or a payment's adapter states it: items, the month it starts, and how many months. */
export const planOf = (value: unknown): Plan | undefined => {
  const stated = value as Record<string, unknown> | null
  if (typeof stated !== "object" || stated === null || !Array.isArray(stated.items) || stated.items.length === 0) return undefined
  if (!stated.items.every(isItem) || typeof stated.starts !== "string" || !PERIOD.test(stated.starts)) return undefined
  if (!Number.isSafeInteger(stated.months) || (stated.months as number) < 1 || (stated.months as number) > 36) return undefined
  const keys = stated.items.map((item) => `${item.product}:${item.cap}`)
  if (new Set(keys).size !== keys.length) return undefined
  const ends = Array.from({ length: stated.months as number }).reduce<string>((period) => nextPeriod(period), stated.starts)
  return { items: stated.items, starts: stated.starts, ends }
}
