import type { Settings } from "./settings"
import { LABELS } from "./routing"

/**
 * NIP-11's document. `pln` says what a P-Lens client may count on beyond
 * NIP-01: the protocol's version, and that a line may be given a bucket of
 * its own by a label at the end of the relay's address (PROTOCOL.md §12), and,
 * where it is gated, the issuer its tickets come from and the key they are
 * read by, which every client blinds under, so that the issuer cannot single
 * one out by a key of its own.
 */
export const informationOf = (settings: Settings) => ({
  name: settings.name,
  description: settings.description,
  supported_nips: [1, 9, 11, 40],
  limitation: {
    max_message_length: settings.rules.maxEventBytes,
    max_subscriptions: settings.mostSubscriptions,
    max_filters: settings.mostFilters,
    max_limit: settings.rules.maxLimit,
    default_limit: settings.rules.defaultLimit.order === "newest" ? settings.rules.defaultLimit.count : undefined,
    created_at_upper_limit: settings.rules.maxFutureSeconds,
    auth_required: false,
    payment_required: settings.gate.mode === "gated",
    restricted_writes: settings.gate.mode !== "open",
  },
  pln: { version: 1, labels: LABELS, entitlement: settings.gate.mode, ...(settings.issuer === undefined ? {} : { issuer: settings.issuer }) },
})
