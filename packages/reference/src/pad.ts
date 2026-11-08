import { Err, Ok, type Result } from "./result"

/** The most bytes one seal carries before padding; anything larger goes in parts. */
export const MOST_UNPADDED = 32_000

export type PadError = { readonly type: "empty" } | { readonly type: "too-large"; readonly length: number }

export type UnpadError = { readonly type: "malformed-padding" }

/** NIP-44 v2's padded length for an unpadded length. */
export const paddedLength = (length: number): number => {
  if (length <= 32) return 32
  const nextPower = 2 ** (Math.floor(Math.log2(length - 1)) + 1)
  const chunk = nextPower <= 256 ? 32 : nextPower / 8
  return chunk * (Math.floor((length - 1) / chunk) + 1)
}

/** A 2-byte big-endian length, the bytes, and zeros to the padded length. */
export const pad = (bytes: Uint8Array): Result<Uint8Array<ArrayBuffer>, PadError> => {
  if (bytes.length === 0) return Err({ type: "empty" })
  if (bytes.length > MOST_UNPADDED) return Err({ type: "too-large", length: bytes.length })
  const padded = new Uint8Array(2 + paddedLength(bytes.length))
  padded[0] = bytes.length >> 8
  padded[1] = bytes.length & 0xff
  padded.set(bytes, 2)
  return Ok(padded)
}

export const unpad = (padded: Uint8Array): Result<Uint8Array<ArrayBuffer>, UnpadError> => {
  const length = ((padded[0] ?? 0) << 8) | (padded[1] ?? 0)
  const wellFormed = length >= 1 && length <= MOST_UNPADDED && padded.length === 2 + paddedLength(length)
  return wellFormed ? Ok(padded.slice(2, 2 + length)) : Err({ type: "malformed-padding" })
}
