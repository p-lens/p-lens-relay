import { RULES, type Rules } from "@p-lens-relay/core"

/** What a misbehaving relay does, each switchable; shares are between 0 and 1. */
export type Quirks = {
  readonly rules: Rules
  readonly seed: number
  /** Share of events answered OK and then lost. */
  readonly drops: number
  readonly dropsEphemeral: boolean
  readonly reorders: boolean
  /** Share of stored events given twice. */
  readonly repeats: number
  /** For how long the same filters are given what they found the first time; 0 for never. */
  readonly staleCacheSeconds: number
  /** Share of addressable events given as a version they replaced, where one was held. */
  readonly oldVersions: number
  readonly withholdsOk: boolean
}

export const PLAIN: Quirks = {
  rules: RULES,
  seed: 1,
  drops: 0,
  dropsEphemeral: false,
  reorders: false,
  repeats: 0,
  staleCacheSeconds: 0,
  oldVersions: 0,
  withholdsOk: false,
}

/** How relays P-Lens has met behave where NIP-01 leaves them free. */
export const PRESETS = {
  plain: PLAIN,
  nosflare: { ...PLAIN, rules: { ...RULES, tie: "first-arrival", perMinute: 10 }, staleCacheSeconds: 60 },
  "nostr-rs-relay": { ...PLAIN, rules: { ...RULES, tie: "first-arrival", maxEventBytes: 128_000 } },
  strfry: { ...PLAIN, rules: { ...RULES, maxEventBytes: 65_000 } },
  chaos: { ...PLAIN, drops: 0.1, dropsEphemeral: true, reorders: true, repeats: 0.2, oldVersions: 0.3, staleCacheSeconds: 30 },
} as const satisfies Record<string, Quirks>

export type PresetName = keyof typeof PRESETS
