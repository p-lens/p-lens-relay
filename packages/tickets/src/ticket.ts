import { fromBase64Url, toBase64Url, toHex, utf8 } from "./bytes"
import { infoOf, infoText, type TicketInfo } from "./info"
import { blind, blindSign, finalize, PREFIX_BYTES, verify, type PbrsaError, type PrivateNumbers, type PublicNumbers } from "./pbrsa"

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: PbrsaError }

/** What a device keeps between asking the issuer and hearing back; only `blinded` is ever sent. */
export type Pending = { readonly info: TicketInfo; readonly message: Uint8Array; readonly inverse: Uint8Array; readonly blinded: Uint8Array }

/** A ticket as redeemed: the `claim` of PROTOCOL.md §9.3, `info.message.signature`, each base64url. */
export type Claim = string

/** A message drawn as RSAPBSSA-SHA384-PSS-Randomized draws one: a random prefix before a random nonce. */
const drawnMessage = (): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(PREFIX_BYTES + 32))

/** Draws a ticket's message and blinds it under the issuer's key and the ticket's public information. */
export const blindTicket = async (key: PublicNumbers, info: TicketInfo): Promise<Outcome<Pending>> => {
  const message = drawnMessage()
  const blinded = await blind(key, message, utf8(infoText(info)))
  return blinded.ok ? { ok: true, value: { info, message, inverse: blinded.value.inverse, blinded: blinded.value.blinded } } : blinded
}

/** The issuer's signature over a blinded message, under the public information asked for. */
export const signBlinded = (key: PrivateNumbers, blinded: Uint8Array, info: TicketInfo): Promise<Outcome<Uint8Array>> =>
  blindSign(key, blinded, utf8(infoText(info)))

/** The ticket, once the issuer's blinded signature is back and holds. */
export const finishTicket = async (key: PublicNumbers, pending: Pending, blindSignature: Uint8Array): Promise<Outcome<Claim>> => {
  const text = infoText(pending.info)
  const signature = await finalize(key, pending.message, utf8(text), blindSignature, pending.inverse)
  return signature.ok
    ? { ok: true, value: [toBase64Url(utf8(text)), toBase64Url(pending.message), toBase64Url(signature.value)].join(".") }
    : signature
}

/** A ticket as the relay reads it: what it pays for, and what it is known by once spent. */
export type ReadTicket = { readonly info: TicketInfo; readonly key: string }

const partsOf = (claim: string) => {
  const parts = claim.split(".")
  if (parts.length !== 3) return undefined
  const [infoPart, messagePart, signaturePart] = parts.map(fromBase64Url)
  return infoPart === undefined || messagePart === undefined || signaturePart === undefined
    ? undefined
    : { text: new TextDecoder().decode(infoPart), message: messagePart, signature: signaturePart }
}

/**
 * Reads a ticket with the issuer's public key: it holds when the signature is
 * the issuer's over its message and its public information. It is known, once
 * spent, by its message's SHA-256: the message is drawn at random, and nobody
 * but the device that drew it knows it before it is redeemed.
 */
export const readTicket = async (key: PublicNumbers, claim: Claim): Promise<ReadTicket | undefined> => {
  const parts = partsOf(claim)
  const info = parts === undefined ? undefined : infoOf(parts.text)
  if (parts === undefined || info === undefined || parts.message.length !== PREFIX_BYTES + 32) return undefined
  if (!(await verify(key, parts.signature, parts.message, utf8(parts.text)))) return undefined
  return { info, key: toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", parts.message))) }
}
