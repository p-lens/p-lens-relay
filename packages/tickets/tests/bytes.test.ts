import { describe, expect, test } from "bun:test"
import { fromBase64, fromBase64Url, toBase64, toBase64Url, toHex } from "../src/bytes"

const samples = [0, 1, 2, 3, 4, 31, 32, 33, 255, 256].map((length) => Uint8Array.from({ length }, (_, index) => (index * 37 + length) % 256))

describe("bytes written without Buffer", () => {
  test.each(samples.map((bytes) => [bytes.length, bytes] as const))("of %d go and come back as Node writes them", (_, bytes) => {
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"))
    expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"))
    expect(toHex(bytes)).toBe(Buffer.from(bytes).toString("hex"))
    if (bytes.length > 0) {
      expect(fromBase64(toBase64(bytes))).toEqual(bytes)
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes)
    }
  })

  test.each(["a", "ab=c", "a*b", "abcde"])("refuse %p as base64", (text) => {
    expect(fromBase64(text)).toBeUndefined()
  })

  test.each(["a", "a*b", "abcde", "ab=c"])("refuse %p as base64url", (text) => {
    expect(fromBase64Url(text)).toBeUndefined()
  })
})
