/**
 * RSAPBSSA-SHA384-PSS: RSA partially blind signatures, as
 * draft-amjad-cfrg-partially-blind-rsa-02 gives them over RFC 9474, in
 * native BigInt. Written out because each ticket's public information
 * derives a public exponent half as long as the modulus, which the
 * browsers' WebCrypto (BoringSSL caps an exponent at 33 bits) and Bun's
 * refuse, so that neither a phone finishing a ticket nor a relay reading one
 * could use it. Checked against the draft's test vectors.
 */

/** A public key's numbers: the modulus, and its length in bytes. */
export type PublicNumbers = { readonly n: bigint; readonly bytes: number }

/** A private key's numbers: the safe primes the derived exponents are inverted over. */
export type PrivateNumbers = PublicNumbers & { readonly p: bigint; readonly q: bigint }

export type PbrsaError =
  | { readonly type: "message-too-long" }
  | { readonly type: "not-invertible" }
  | { readonly type: "unexpected-size" }
  | { readonly type: "signing-failure" }
  | { readonly type: "invalid-signature" }

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: PbrsaError }

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value })
const failed = (type: PbrsaError["type"]): Outcome<never> => ({ ok: false, error: { type } })

/** SHA-384's length, and the salt's: RSAPBSSA-SHA384-PSS salts with as many bytes as the hash. */
const HASH_BYTES = 48
const SALT_BYTES = 48

/** The random prefix a Randomized variant puts before a message (RFC 9474 §4.1). */
export const PREFIX_BYTES = 32

const concat = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const whole = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  parts.reduce((offset, part) => (whole.set(part, offset), offset + part.length), 0)
  return whole
}

const sha384 = async (bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => new Uint8Array(await crypto.subtle.digest("SHA-384", concat(bytes)))

export const toInteger = (bytes: Uint8Array): bigint => bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)

export const toBytes = (value: bigint, length: number): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length }, (_, index) => Number((value >> BigInt(8 * (length - 1 - index))) & 0xffn))

const bitLength = (value: bigint): number => value.toString(2).length

const modPow = (base: bigint, exponent: bigint, modulus: bigint): bigint => {
  const step = (result: bigint, square: bigint, rest: bigint): bigint =>
    rest === 0n ? result : step(rest & 1n ? (result * square) % modulus : result, (square * square) % modulus, rest >> 1n)
  return step(1n, base % modulus, exponent)
}

/** The inverse of a modulo m, or nothing when they share a factor. */
export const modInverse = (a: bigint, m: bigint): bigint | undefined => {
  const walk = (oldR: bigint, r: bigint, oldS: bigint, s: bigint): readonly [bigint, bigint] =>
    r === 0n ? [oldR, oldS] : walk(r, oldR - (oldR / r) * r, s, oldS - (oldR / r) * s)
  const [gcd, s] = walk(((a % m) + m) % m, m, 1n, 0n)
  return gcd === 1n ? ((s % m) + m) % m : undefined
}

const int4 = (value: number): Uint8Array<ArrayBuffer> => toBytes(BigInt(value), 4)

/** concat("msg", int_to_bytes(len(info), 4), info, msg): what is signed, the information bound in. */
const messagePrime = (message: Uint8Array, info: Uint8Array): Uint8Array<ArrayBuffer> =>
  concat(new TextEncoder().encode("msg"), int4(info.length), info, message)

const mgf1 = async (seed: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> => {
  const blocks = await Promise.all(
    Array.from({ length: Math.ceil(length / HASH_BYTES) }, (_, counter) => sha384(concat(seed, int4(counter)))),
  )
  return concat(...blocks).slice(0, length)
}

const xor = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(a, (byte, index) => byte ^ (b[index] ?? 0))

/** EMSA-PSS-ENCODE (RFC 8017 §9.1.1) with SHA-384, MGF1-SHA-384, and the salt given. */
const pssEncode = async (message: Uint8Array, emBits: number, salt: Uint8Array): Promise<Outcome<Uint8Array<ArrayBuffer>>> => {
  const emLength = Math.ceil(emBits / 8)
  if (emLength < HASH_BYTES + salt.length + 2) return failed("message-too-long")
  const hash = await sha384(concat(new Uint8Array(8), await sha384(message), salt))
  const db = concat(new Uint8Array(emLength - salt.length - HASH_BYTES - 2), Uint8Array.of(1), salt)
  const masked = xor(db, await mgf1(hash, emLength - HASH_BYTES - 1))
  masked[0] = (masked[0] ?? 0) & (0xff >> (8 * emLength - emBits))
  return ok(concat(masked, hash, Uint8Array.of(0xbc)))
}

/** EMSA-PSS-VERIFY (RFC 8017 §9.1.2), with the salt as long as the hash. */
const pssHolds = async (message: Uint8Array, encoded: Uint8Array, emBits: number): Promise<boolean> => {
  const emLength = Math.ceil(emBits / 8)
  const topMask = 0xff >> (8 * emLength - emBits)
  if (encoded.length !== emLength || emLength < HASH_BYTES + SALT_BYTES + 2 || encoded[emLength - 1] !== 0xbc) return false
  const masked = encoded.slice(0, emLength - HASH_BYTES - 1)
  const hash = encoded.slice(emLength - HASH_BYTES - 1, emLength - 1)
  if (((masked[0] ?? 0) & ~topMask) !== 0) return false
  const db = xor(masked, await mgf1(hash, masked.length))
  db[0] = (db[0] ?? 0) & topMask
  const padding = db.slice(0, emLength - HASH_BYTES - SALT_BYTES - 2)
  if (padding.some((byte) => byte !== 0) || db[padding.length] !== 1) return false
  const salt = db.slice(db.length - SALT_BYTES)
  const expected = await sha384(concat(new Uint8Array(8), await sha384(message), salt))
  return expected.every((byte, index) => byte === hash[index])
}

/** The public exponent the information derives (the draft's DerivePublicKey). */
export const derivedExponent = async (key: PublicNumbers, info: Uint8Array): Promise<bigint> => {
  const lambda = Math.floor(bitLength(key.n) / 16)
  const input = await crypto.subtle.importKey("raw", concat(new TextEncoder().encode("key"), info, Uint8Array.of(0)), "HKDF", false, ["deriveBits"])
  const expanded = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-384", salt: toBytes(key.n, Math.floor(bitLength(key.n) / 8)), info: new TextEncoder().encode("PBRSA") },
      input,
      (lambda + 16) * 8,
    ),
  )
  expanded[0] = (expanded[0] ?? 0) & 0x3f
  expanded[lambda - 1] = (expanded[lambda - 1] ?? 0) | 0x01
  return toInteger(expanded.slice(0, lambda))
}

/** What a device keeps after blinding: the blinded message to send, and the inverse to unblind with. */
export type Blinded = { readonly blinded: Uint8Array<ArrayBuffer>; readonly inverse: Uint8Array<ArrayBuffer> }

/** Blind with the salt and the blinding factor given: drawn at random by `blind`, fixed by the test vectors. */
export const blindWith = async (key: PublicNumbers, message: Uint8Array, info: Uint8Array, salt: Uint8Array, r: bigint): Promise<Outcome<Blinded>> => {
  const encoded = await pssEncode(messagePrime(message, info), bitLength(key.n) - 1, salt)
  if (!encoded.ok) return encoded
  const m = toInteger(encoded.value)
  const inverse = modInverse(r, key.n)
  if (inverse === undefined || m >= key.n) return failed("not-invertible")
  const x = modPow(r, await derivedExponent(key, info), key.n)
  return ok({ blinded: toBytes((m * x) % key.n, key.bytes), inverse: toBytes(inverse, key.bytes) })
}

const randomBelow = (n: bigint, bytes: number): bigint => {
  const drawn = toInteger(crypto.getRandomValues(new Uint8Array(bytes)))
  return drawn > 0n && drawn < n && modInverse(drawn, n) !== undefined ? drawn : randomBelow(n, bytes)
}

export const blind = (key: PublicNumbers, message: Uint8Array, info: Uint8Array): Promise<Outcome<Blinded>> =>
  blindWith(key, message, info, crypto.getRandomValues(new Uint8Array(SALT_BYTES)), randomBelow(key.n, key.bytes))

/** The issuer's signature over a blinded message, under the key the information derives (the draft's BlindSign). */
export const blindSign = async (key: PrivateNumbers, blinded: Uint8Array, info: Uint8Array): Promise<Outcome<Uint8Array<ArrayBuffer>>> => {
  if (blinded.length !== key.bytes) return failed("unexpected-size")
  const m = toInteger(blinded)
  if (m >= key.n) return failed("unexpected-size")
  const exponent = await derivedExponent(key, info)
  const d = modInverse(exponent, (key.p - 1n) * (key.q - 1n))
  if (d === undefined) return failed("signing-failure")
  const sp = modPow(m, d % (key.p - 1n), key.p)
  const sq = modPow(m, d % (key.q - 1n), key.q)
  const qInverse = modInverse(key.q, key.p) ?? 0n
  const s = sq + key.q * ((((sp - sq) * qInverse) % key.p + key.p) % key.p)
  return modPow(s, exponent, key.n) === m ? ok(toBytes(s, key.bytes)) : failed("signing-failure")
}

/** Whether a signature holds over a message and its information (the draft's verification). */
export const verify = async (key: PublicNumbers, signature: Uint8Array, message: Uint8Array, info: Uint8Array): Promise<boolean> => {
  if (signature.length !== key.bytes) return false
  const s = toInteger(signature)
  if (s >= key.n) return false
  const emBits = bitLength(key.n) - 1
  const m = modPow(s, await derivedExponent(key, info), key.n)
  return m < 2n ** BigInt(Math.ceil(emBits / 8) * 8) && pssHolds(messagePrime(message, info), toBytes(m, Math.ceil(emBits / 8)), emBits)
}

/** The signature, unblinded and checked (the draft's Finalize). */
export const finalize = async (
  key: PublicNumbers,
  message: Uint8Array,
  info: Uint8Array,
  blindSignature: Uint8Array,
  inverse: Uint8Array,
): Promise<Outcome<Uint8Array<ArrayBuffer>>> => {
  if (blindSignature.length !== key.bytes || inverse.length !== key.bytes) return failed("unexpected-size")
  const signature = toBytes((toInteger(blindSignature) * toInteger(inverse)) % key.n, key.bytes)
  return (await verify(key, signature, message, info)) ? ok(signature) : failed("invalid-signature")
}
