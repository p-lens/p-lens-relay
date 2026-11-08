import { emptyRelay, readClientMessage, step, tagValues, type ConnectionId, type NostrEvent, type Outgoing, type RelayState, type Rules } from "@p-lens-relay/core"
import { KIND } from "./kinds"
import { emptyLedger, redeemed, type Ledger } from "./ledger"
import { judge, type GateConfig, type Refusal, type TicketReading } from "./judge"
import { memoryView } from "./view"

export type GatedState = { readonly relay: RelayState; readonly ledger: Ledger }

export const emptyGated: GatedState = { relay: emptyRelay, ledger: emptyLedger }

/** Reads a redemption's `claim` with the issuer's key. */
export type TicketReader = (claim: string) => Promise<TicketReading>

/** The `OK` reason a refusal is sent with, under NIP-01's prefixes. */
export const reasonOf = (refusal: Refusal): string => {
  switch (refusal.type) {
    case "shape":
      return refusal.fault.type === "foreign-kind" ? `blocked: kind ${refusal.fault.kind} is not P-Lens's` : `invalid: ${refusal.fault.type}`
    case "bad-list":
      return "invalid: access list"
    case "second-list":
      return `invalid: one ${refusal.product} access list per owner`
    case "pass-required":
      return `restricted: pass-required for ${refusal.product}`
    case "full":
      return "restricted: full"
    case "not-listed":
      return "restricted: not on the access list"
    case "no-payment-here":
      return "restricted: this relay takes no payment"
    case "bad-ticket":
      return "invalid: ticket"
    case "ticket-spent":
      return "invalid: ticket already redeemed"
    case "ticket-out-of-period":
      return "invalid: ticket not for this month"
  }
}

const eventOf = (raw: string): NostrEvent | undefined => {
  const message = readClientMessage(raw)
  return message.type === "event" ? message.event : undefined
}

const answer = (to: ConnectionId, event: NostrEvent, accepted: boolean, reason: string): readonly Outgoing[] => [
  { to, message: ["OK", event.id, accepted, reason] },
]

const readClaim = (readTicket: TicketReader, event: NostrEvent): Promise<TicketReading | undefined> => {
  const claim = event.kind === KIND.redemption ? tagValues(event, "claim")[0] : undefined
  return claim === undefined ? Promise.resolve(undefined) : readTicket(claim)
}

/**
 * One message to a P-Lens relay: a valid event is judged by the gate before
 * the relay core takes it; everything else goes to the core as it is. A
 * redemption is answered here and never passed on, so that no subscriber sees
 * a ticket.
 */
export const gatedStep = async (
  config: GateConfig,
  rules: Rules,
  readTicket: TicketReader,
  state: GatedState,
  from: ConnectionId,
  raw: string,
  now: number,
): Promise<{ readonly state: GatedState; readonly outgoing: readonly Outgoing[] }> => {
  const event = eventOf(raw)
  if (event === undefined) {
    const next = step(rules, state.relay, from, raw, now)
    return { state: { ...state, relay: next.state }, outgoing: next.outgoing }
  }
  const verdict = judge(config, memoryView(state.relay.store, state.ledger, now), event, await readClaim(readTicket, event), now)
  switch (verdict.type) {
    case "refuse":
      return { state, outgoing: answer(from, event, false, reasonOf(verdict.refusal)) }
    case "redeem":
      return { state: { ...state, ledger: redeemed(state.ledger, verdict.key, verdict.grant, verdict.ticket, now) }, outgoing: answer(from, event, true, "") }
    case "accept": {
      const next = step(rules, state.relay, from, raw, now)
      return { state: { ...state, relay: next.state }, outgoing: next.outgoing }
    }
  }
}
