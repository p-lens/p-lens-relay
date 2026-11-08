/** Base64 and hex written with what browsers, Workers and Bun all have: never Node's `Buffer`. */
const binary = (bytes: Uint8Array): string => Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")

const fromBinary = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(text, (character) => character.charCodeAt(0))

export const toBase64 = (bytes: Uint8Array): string => btoa(binary(bytes))

export const fromBase64 = (text: string): Uint8Array<ArrayBuffer> | undefined =>
  /^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0 ? fromBinary(atob(text)) : undefined

export const toBase64Url = (bytes: Uint8Array): string => toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return undefined
  const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=")
  return fromBinary(atob(padded))
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")

export const utf8 = (text: string): Uint8Array<ArrayBuffer> => new Uint8Array(new TextEncoder().encode(text))
