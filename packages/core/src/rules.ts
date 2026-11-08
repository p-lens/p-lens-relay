import type { DefaultLimit, Tie } from "./keeping"

/** How a relay behaves where NIP-01 leaves it free. */
export type Rules = {
  readonly tie: Tie
  readonly defaultLimit: DefaultLimit
  readonly maxLimit: number
  readonly maxEventBytes: number
  readonly maxFutureSeconds: number
  /** Events one connection may send in a minute; none when undefined. */
  readonly perMinute: number | undefined
}

export const RULES: Rules = {
  tie: "lowest-id",
  defaultLimit: { order: "newest", count: 500 },
  maxLimit: 500,
  maxEventBytes: 64_000,
  maxFutureSeconds: 900,
  perMinute: undefined,
}
