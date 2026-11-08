import { RULES, type Rules } from "@p-lens-relay/core"
import { CAPS, type GateConfig } from "@p-lens-relay/gate"

/** Where a gated relay's tickets come from: the issuer's address, for clients, and its public key, SPKI base64. */
export type Issuer = { readonly url: string; readonly key: string }

/** How a deployment of the relay is set, from its environment. */
export type Settings = {
  readonly gate: GateConfig
  readonly issuer: Issuer | undefined
  readonly rules: Rules
  readonly name: string
  readonly description: string
  /** Subscriptions one socket may hold open at once. */
  readonly mostSubscriptions: number
  /** Filters one subscription may hold. */
  readonly mostFilters: number
}

export type SettingsError =
  | { readonly type: "unknown-entitlement"; readonly given: string }
  | { readonly type: "issuer-missing"; readonly missing: "ISSUER_URL" | "ISSUER_PUBLIC_KEY" }
  | { readonly type: "issuer-url-not-https"; readonly given: string }

/** What a relay holds every event to: the shape PLN-1 gives one, with room for its largest seal. */
const OFFICIAL_RULES: Rules = { ...RULES, maxEventBytes: 64_000, maxLimit: 500, defaultLimit: { order: "newest", count: 500 } }

export type Environment = Readonly<Record<string, string | undefined>>

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SettingsError }

const issuerOf = (environment: Environment): Read<Issuer> => {
  const url = environment.ISSUER_URL
  const key = environment.ISSUER_PUBLIC_KEY
  if (url === undefined) return { ok: false, error: { type: "issuer-missing", missing: "ISSUER_URL" } }
  if (key === undefined) return { ok: false, error: { type: "issuer-missing", missing: "ISSUER_PUBLIC_KEY" } }
  if (!url.startsWith("https://")) return { ok: false, error: { type: "issuer-url-not-https", given: url } }
  return { ok: true, value: { url, key } }
}

/**
 * Reads the environment: `ENTITLEMENT` is `open` (anyone's own relay, the
 * default), `capped` (the official relay before payment) or `gated` (the
 * official relay with payment, needing `ISSUER_URL` and `ISSUER_PUBLIC_KEY`).
 * `RELAY_NAME` and `RELAY_DESCRIPTION` are what NIP-11 says.
 */
export const settingsOf = (environment: Environment): Read<Settings> => {
  const entitlement = environment.ENTITLEMENT ?? "open"
  if (entitlement !== "open" && entitlement !== "capped" && entitlement !== "gated") {
    return { ok: false, error: { type: "unknown-entitlement", given: entitlement } }
  }
  const issuer = entitlement === "gated" ? issuerOf(environment) : undefined
  if (issuer !== undefined && !issuer.ok) return issuer
  return {
    ok: true,
    value: {
      gate: { mode: entitlement, caps: CAPS },
      issuer: issuer?.value,
      rules: OFFICIAL_RULES,
      name: environment.RELAY_NAME ?? "P-Lens relay",
      description: environment.RELAY_DESCRIPTION ?? "Carries P-Lens's books, plays and huddles, sealed end to end (PLN-1).",
      mostSubscriptions: 20,
      mostFilters: 10,
    },
  }
}

export const settingsErrorText = (error: SettingsError): string => {
  switch (error.type) {
    case "unknown-entitlement":
      return `ENTITLEMENT is open, capped or gated, not ${error.given}`
    case "issuer-missing":
      return `ENTITLEMENT=gated needs ${error.missing}`
    case "issuer-url-not-https":
      return `ISSUER_URL is an https:// address, not ${error.given}`
  }
}
