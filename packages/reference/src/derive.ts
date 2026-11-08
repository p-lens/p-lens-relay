import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js"
import { concat, toHex, utf8 } from "./bytes"

/** The salt every PLN-1 key is derived under. */
const SALT = utf8("p-lens/pln-1")

const ORDER = secp256k1.Point.CURVE().n

/** A BIP-340 key pair, and which counter gave it. */
export type SigningKey = { readonly secret: Uint8Array; readonly pubkey: string; readonly counter: number }

const label = (text: string | Uint8Array): Uint8Array<ArrayBuffer> => (typeof text === "string" ? utf8(text) : concat(text))

/** HKDF-SHA256 of a secret under the PLN-1 salt and a label, 32 bytes. */
export const derive = async (secret: Uint8Array, info: string | Uint8Array): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await crypto.subtle.importKey("raw", concat(secret), "HKDF", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: SALT, info: label(info) }, key, 256)
  return new Uint8Array(bits)
}

const asScalar = (bytes: Uint8Array): bigint => BigInt(`0x${toHex(bytes)}`)

const isScalar = (value: bigint): boolean => value >= 1n && value < ORDER

/** The least counter whose derivation is a valid secp256k1 secret key. */
const signingKeyFrom = async (secret: Uint8Array, name: string, counter: number): Promise<SigningKey> => {
  const candidate = await derive(secret, `sign:${name}:${counter}`)
  return isScalar(asScalar(candidate))
    ? { secret: candidate, pubkey: toHex(schnorr.getPublicKey(candidate)), counter }
    : signingKeyFrom(secret, name, counter + 1)
}

export const signingKey = (secret: Uint8Array, name: string): Promise<SigningKey> => signingKeyFrom(secret, name, 0)

export const sealKey = (secret: Uint8Array, name: string): Promise<Uint8Array<ArrayBuffer>> => derive(secret, `seal:${name}`)

/** A line's `v`: 16 derived bytes as lowercase hex. */
export const locator = async (secret: Uint8Array, name: string): Promise<string> =>
  toHex((await derive(secret, `locator:${name}`)).subarray(0, 16))

/** An addressable event's `d`: 16 bytes of an HMAC under a derived key, as lowercase hex. */
export const address = async (secret: Uint8Array, name: string): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", await derive(secret, "address"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(name))).subarray(0, 16))
}
