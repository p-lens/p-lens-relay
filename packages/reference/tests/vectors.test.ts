import { gcm } from "@noble/ciphers/aes.js"
import { hkdf } from "@noble/hashes/hkdf.js"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { schnorr } from "@noble/curves/secp256k1.js"
import { describe, expect, test } from "bun:test"
import { inflateRawSync } from "node:zlib"
import { concat, fromBase64, fromHex, toHex, utf8 } from "../src/bytes"
import { aad, openJson, sealBytes, type Place } from "../src/seal"
import { pad, unpad, MOST_UNPADDED } from "../src/pad"
import { INPUTS, vectorsFrom, type Vectors } from "../src/vectors"

const written = (await Bun.file(new URL("../vectors/pln-1.json", import.meta.url)).json()) as Vectors & { inputs: typeof INPUTS }
const SALT = utf8("p-lens/pln-1")

/** HKDF by another library than the reference's WebCrypto, to check the vectors against. */
const otherDerive = (secret: string, info: Uint8Array): Uint8Array => hkdf(sha256, fromHex(secret), SALT, info, 32)

describe("the written vectors", () => {
  test("are what the reference works out from their inputs", async () => {
    const fresh = await vectorsFrom(written.inputs)
    const { seal: freshSeal, ...freshRest } = fresh
    const { seal: writtenSeal, inputs: _, ...writtenRest } = written
    expect(writtenRest).toEqual(freshRest)
    expect({ ...writtenSeal, compressed: "", content: "" }).toEqual({ ...freshSeal, compressed: "", content: "" })
  })

  test("seal their compressed bytes to their content", async () => {
    const sealed = await sealBytes(fromHex(written.seal.key), fromHex(written.seal.nonce), written.seal.place, fromHex(written.seal.compressed))
    expect(sealed).toEqual({ ok: true, value: written.seal.content })
  })
})

describe("another implementation agrees", () => {
  test("on derivation", () => {
    expect(toHex(otherDerive(INPUTS.sync, utf8("owner")))).toBe(written.derive.output)
  })

  test("on signing keys", () => {
    const owner = written.keys.owner
    expect(toHex(otherDerive(INPUTS.sync, utf8(`sign:owner:${owner.counter}`)))).toBe(owner.secret)
    expect(toHex(schnorr.getPublicKey(fromHex(owner.secret)))).toBe(owner.pubkey)
  })

  test("on a participant's root", () => {
    expect(toHex(otherDerive(INPUTS.huddle, concat(utf8("device:"), fromHex(INPUTS.device))))).toBe(written.keys.participant.root)
  })

  test("on locators and addresses", () => {
    expect(toHex(otherDerive(INPUTS.epoch, utf8("locator:book")).subarray(0, 16))).toBe(written.lines.book)
    const addressKey = otherDerive(INPUTS.sync, utf8("address"))
    expect(toHex(hmac(sha256, addressKey, utf8("sharing")).subarray(0, 16))).toBe(written.addresses.sharing)
  })

  test("on opening the seal", () => {
    const box = fromBase64(written.seal.content)
    expect(box[0]).toBe(1)
    const padded = gcm(fromHex(written.seal.key), box.subarray(1, 13), aad(written.seal.place)).decrypt(box.subarray(13))
    const length = ((padded[0] ?? 0) << 8) | (padded[1] ?? 0)
    expect(toHex(padded.subarray(2, 2 + length))).toBe(written.seal.compressed)
    expect(inflateRawSync(padded.subarray(2, 2 + length)).toString("utf8")).toBe(written.seal.json)
  })
})

describe("a seal", () => {
  test("opens where it was sealed", async () => {
    expect(await openJson(fromHex(written.seal.key), written.seal.place, written.seal.content)).toEqual({ ok: true, value: INPUTS.sealed })
  })

  const moved: readonly (readonly [string, Partial<Place>])[] = [
    ["another kind", { kind: 34741 }],
    ["another line", { v: "0".repeat(32) }],
    ["another address", { d: "0".repeat(32) }],
    ["no address", { d: undefined }],
    ["another author", { pubkey: written.keys.member.pubkey }],
  ]

  test.each(moved)("does not open moved to %s", async (_, change) => {
    const opened = await openJson(fromHex(written.seal.key), { ...written.seal.place, ...change }, written.seal.content)
    expect(opened).toEqual({ ok: false, error: { type: "does-not-open" } })
  })

  test("does not open under another key", async () => {
    expect(await openJson(fromHex(written.sealKeys.book), written.seal.place, written.seal.content)).toEqual({
      ok: false,
      error: { type: "does-not-open" },
    })
  })
})

describe("padding", () => {
  test("goes back to what was padded", () => {
    const bytes = utf8("x".repeat(300))
    const padded = pad(bytes)
    expect(padded.ok && unpad(padded.value)).toEqual({ ok: true, value: bytes })
  })

  test("refuses nothing and more than a seal carries", () => {
    expect(pad(new Uint8Array(0))).toEqual({ ok: false, error: { type: "empty" } })
    expect(pad(new Uint8Array(MOST_UNPADDED + 1))).toEqual({ ok: false, error: { type: "too-large", length: MOST_UNPADDED + 1 } })
  })

  test("keeps the largest seal within an event a relay must take", () => {
    const padded = pad(new Uint8Array(MOST_UNPADDED))
    const content = padded.ok ? Math.ceil((1 + 12 + padded.value.length + 16) / 3) * 4 : Infinity
    expect(content).toBeLessThan(44_000)
  })
})
