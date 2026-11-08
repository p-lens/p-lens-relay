import { fromBase64, fromBase64Url, toBase64, toBase64Url } from "./bytes"
import { modInverse, toBytes, toInteger, type PrivateNumbers, type PublicNumbers } from "./pbrsa"

/** How WebCrypto is told to hold the keys: it only reads and writes them here, and never signs with them. */
const ALGORITHM = { name: "RSA-PSS", hash: "SHA-384" } as const

const numberOf = (field: string | undefined): bigint | undefined => {
  const bytes = field === undefined ? undefined : fromBase64Url(field)
  return bytes === undefined ? undefined : toInteger(bytes)
}

const jwkOf = async (format: "spki" | "pkcs8", text: string): Promise<JsonWebKey | undefined> => {
  const bytes = fromBase64(text)
  if (bytes === undefined) return undefined
  return crypto.subtle
    .importKey(format, bytes, ALGORITHM, true, format === "spki" ? ["verify"] : ["sign"])
    .then((key) => crypto.subtle.exportKey("jwk", key) as Promise<JsonWebKey>)
    .catch(() => undefined)
}

const modulusOf = (n: bigint): PublicNumbers => ({ n, bytes: Math.ceil(n.toString(2).length / 8) })

/** The issuer's public key read from SPKI, base64: the form `ISSUER_PUBLIC_KEY` takes. */
export const importPublicKey = async (text: string): Promise<PublicNumbers | undefined> => {
  const n = numberOf((await jwkOf("spki", text))?.n)
  return n === undefined ? undefined : modulusOf(n)
}

/** The issuer's private key read from PKCS #8, base64: the form `ISSUER_PRIVATE_KEY` takes. */
export const importPrivateKey = async (text: string): Promise<PrivateNumbers | undefined> => {
  const jwk = await jwkOf("pkcs8", text)
  const [n, p, q] = [numberOf(jwk?.n), numberOf(jwk?.p), numberOf(jwk?.q)]
  return n === undefined || p === undefined || q === undefined ? undefined : { ...modulusOf(n), p, q }
}

const field = (value: bigint, bytes: number): string => toBase64Url(toBytes(value, bytes))

/** A key pair from two safe primes, written as `importPublicKey` and `importPrivateKey` read it. */
export const keyTexts = async (p: bigint, q: bigint): Promise<{ readonly publicKey: string; readonly privateKey: string }> => {
  const n = p * q
  const e = 65_537n
  const d = modInverse(e, (p - 1n) * (q - 1n))
  const qi = modInverse(q, p)
  if (d === undefined || qi === undefined) throw new Error("the primes make no key")
  const bytes = Math.ceil(n.toString(2).length / 8)
  const half = Math.ceil(p.toString(2).length / 8)
  const jwk: JsonWebKey = {
    kty: "RSA",
    n: field(n, bytes),
    e: "AQAB",
    d: field(d, bytes),
    p: field(p, half),
    q: field(q, half),
    dp: field(d % (p - 1n), half),
    dq: field(d % (q - 1n), half),
    qi: field(qi, half),
  }
  const privateKey = await crypto.subtle.importKey("jwk", jwk, ALGORITHM, true, ["sign"])
  const publicKey = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e }, ALGORITHM, true, ["verify"])
  return {
    publicKey: toBase64(new Uint8Array((await crypto.subtle.exportKey("spki", publicKey)) as ArrayBuffer)),
    privateKey: toBase64(new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer)),
  }
}
