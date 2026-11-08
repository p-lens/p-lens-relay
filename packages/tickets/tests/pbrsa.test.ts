import { describe, expect, test } from "bun:test"
import { blindSign, blindWith, derivedExponent, finalize, toBytes, toInteger, verify, type PrivateNumbers } from "../src/pbrsa"
import vectors from "./fixtures/draft-amjad-cfrg-partially-blind-rsa-02.json"

/** The test vectors of draft-amjad-cfrg-partially-blind-rsa-02 §A, as cloudflare/blindrsa-ts keeps them. */
type Vector = (typeof vectors)[number]

const hex = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))
const big = (text: string): bigint => BigInt(`0x${text}`)
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex")

const keyOf = (vector: Vector): PrivateNumbers => ({ n: big(vector.n), p: big(vector.p), q: big(vector.q), bytes: vector.n.length / 2 })

describe.each(vectors.map((vector, index) => [index, vector] as const))("test vector %d", (_, vector) => {
  const key = keyOf(vector)
  const message = hex(vector.msg)
  const info = hex(vector.info)

  test("derives the public exponent", async () => {
    expect((await derivedExponent(key, info)).toString(16).padStart(vector.eprime.length, "0")).toBe(vector.eprime)
  })

  test("blinds, signs and finalizes to the vector's bytes", async () => {
    const blinded = await blindWith(key, message, info, hex(vector.salt), big(vector.r))
    if (!blinded.ok) throw new Error(blinded.error.type)
    expect(hexOf(blinded.value.blinded)).toBe(vector.blind_msg)
    const blindSignature = await blindSign(key, blinded.value.blinded, info)
    if (!blindSignature.ok) throw new Error(blindSignature.error.type)
    expect(hexOf(blindSignature.value)).toBe(vector.blind_sig)
    const signature = await finalize(key, message, info, blindSignature.value, blinded.value.inverse)
    expect(signature.ok && hexOf(signature.value)).toBe(vector.sig)
  })

  test("verifies the vector's signature, and not under other information or over another message", async () => {
    expect(await verify(key, hex(vector.sig), message, info)).toBe(true)
    expect(await verify(key, hex(vector.sig), message, new TextEncoder().encode("other"))).toBe(false)
    expect(await verify(key, hex(vector.sig), new TextEncoder().encode("other"), info)).toBe(false)
  })

  test("refuses a signature changed by one bit, or too short", async () => {
    const changed = hex(vector.sig)
    changed[100] = (changed[100] ?? 0) ^ 1
    expect(await verify(key, changed, message, info)).toBe(false)
    expect(await verify(key, hex(vector.sig).slice(1), message, info)).toBe(false)
  })

  test("refuses to sign what is not below the modulus", async () => {
    expect(await blindSign(key, toBytes(key.n, key.bytes), info)).toEqual({ ok: false, error: { type: "unexpected-size" } })
  })

  test("keeps integers and bytes the same both ways", () => {
    expect(toInteger(toBytes(key.n, key.bytes))).toBe(key.n)
  })
})
