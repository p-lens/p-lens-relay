const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text)

export const fromUtf8 = (bytes: Uint8Array): string => decoder.decode(bytes)

export const concat = (...parts: readonly ArrayLike<number>[]): Uint8Array<ArrayBuffer> => {
  const whole = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  parts.reduce((offset, part) => {
    whole.set(part, offset)
    return offset + part.length
  }, 0)
  return whole
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const fromHex = (hex: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16))

export const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64")

export const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(text, "base64"))
