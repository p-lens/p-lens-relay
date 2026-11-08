/** Crockford's base 32: no I, L, O or U, so that a code read aloud or typed is not mistaken. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** A plan code's length in characters: 130 bits, of which 128 are drawn. */
const LENGTH = 26

const encoded = (bytes: Uint8Array): string => {
  const bits = Array.from(bytes, (byte) => byte.toString(2).padStart(8, "0")).join("").padEnd(LENGTH * 5, "0")
  return Array.from({ length: LENGTH }, (_, index) => ALPHABET[Number.parseInt(bits.slice(index * 5, index * 5 + 5), 2)]).join("")
}

/** A new plan code, as it is handed to whoever paid: in groups of four, shown once and never kept. */
export const drawCode = (): string => (encoded(crypto.getRandomValues(new Uint8Array(16))).match(/.{1,4}/g) ?? []).join("-")

/** A code as typed, made what it was drawn as: upper case, no spaces or hyphens, O read as 0 and I and L as 1. */
export const normalizedCode = (typed: string): string | undefined => {
  const plain = typed.toUpperCase().replaceAll(/[\s-]/g, "").replaceAll("O", "0").replaceAll(/[IL]/g, "1")
  return plain.length === LENGTH && [...plain].every((character) => ALPHABET.includes(character)) ? plain : undefined
}

/** What a plan is kept under: its code's SHA-256, so that the issuer's storage gives no code away. */
export const codeHash = async (code: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))), (byte) => byte.toString(16).padStart(2, "0")).join("")
