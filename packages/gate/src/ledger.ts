import type { Product } from "./kinds"

/** What one redeemed ticket gives: a cap, for a month and the grace after it. */
export type Grant = { readonly cap: number; readonly from: number; readonly until: number }

/**
 * What the relay keeps of payment: grants by what they bind, and each spent
 * ticket until its grant ends, after which its month refuses it anyway.
 */
export type Ledger = { readonly grants: ReadonlyMap<string, readonly Grant[]>; readonly spent: ReadonlyMap<string, number> }

export const emptyLedger: Ledger = { grants: new Map(), spent: new Map() }

/**
 * How long writes go on after a paid month ends, so that a device which opens
 * on the first of the month has time to fetch and redeem the next ticket.
 */
export const GRACE_SECONDS = 3 * 86_400

/** A month's span in UNIX seconds, `YYYY-MM` in UTC, with the grace after it. */
export const periodSpan = (period: string): Omit<Grant, "cap"> | undefined => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  return { from: Date.UTC(year, month, 1) / 1000, until: Date.UTC(year, month + 1, 1) / 1000 + GRACE_SECONDS }
}

/** What a grant is kept under: an owner's pubkey or a huddle's `v`, and the product. */
export const grantKey = (subject: string, product: Product): string => `${product}:${subject}`

const unexpired = <T>(entries: Iterable<readonly [string, T]>, until: (value: T) => number, now: number): Map<string, T> =>
  new Map([...entries].filter(([, value]) => until(value) > now))

/** The ledger with a ticket spent on a grant, and whatever has run out forgotten. */
export const redeemed = (ledger: Ledger, key: string, grant: Grant, ticket: string, now: number): Ledger => ({
  grants: new Map(ledger.grants).set(key, [...(ledger.grants.get(key) ?? []).filter((held) => held.until > now), grant]),
  spent: unexpired(ledger.spent, (until) => until, now).set(ticket, grant.until),
})

/** The largest cap granted for now, if anything is. */
export const capNow = (ledger: Ledger, key: string, now: number): number | undefined => {
  const caps = (ledger.grants.get(key) ?? []).filter((grant) => grant.from <= now && now < grant.until).map((grant) => grant.cap)
  return caps.length === 0 ? undefined : Math.max(...caps)
}
