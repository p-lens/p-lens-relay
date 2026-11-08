import type { TicketReader } from "@p-lens-relay/gate"
import { importPublicKey, readTicket, type PublicNumbers } from "@p-lens-relay/tickets"

/**
 * Reads tickets with the issuer's public key, read once and kept. A key that
 * cannot be read makes every ticket invalid, and says so once, so that a
 * misset relay refuses payment rather than taking anything.
 */
export const ticketReaderOf = (keyText: string | undefined, warn: (text: string) => void): TicketReader => {
  const held: { key: Promise<PublicNumbers | undefined> | undefined } = { key: undefined }
  const key = (): Promise<PublicNumbers | undefined> => {
    if (held.key === undefined) {
      held.key = keyText === undefined ? Promise.resolve(undefined) : importPublicKey(keyText)
      void held.key.then((read) => (read === undefined && keyText !== undefined ? warn("ISSUER_PUBLIC_KEY cannot be read: every ticket is refused") : undefined))
    }
    return held.key
  }
  return async (claim) => {
    const read = await key().then((publicKey) => (publicKey === undefined ? undefined : readTicket(publicKey, claim)))
    return read === undefined ? { type: "invalid" } : { type: "valid", ...read.info, key: read.key }
  }
}
