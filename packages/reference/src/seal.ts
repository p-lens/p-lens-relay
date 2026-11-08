import { concat, fromBase64, fromUtf8, toBase64, utf8 } from "./bytes"
import { pad, unpad, type PadError, type UnpadError } from "./pad"
import { Err, Ok, type Result } from "./result"

/** The seal's format, the first byte of every sealed content. */
const VERSION = 0x01

const NONCE_LENGTH = 12

/** What a box is stuck to: moved to another kind, line, address or author, it does not open. */
export type Place = { readonly kind: number; readonly v: string; readonly d: string | undefined; readonly pubkey: string }

export type OpenError =
  | { readonly type: "not-base64" }
  | { readonly type: "unknown-version"; readonly version: number | undefined }
  | { readonly type: "does-not-open" }
  | UnpadError
  | { readonly type: "not-inflatable" }
  | { readonly type: "not-json" }

export const aad = (place: Place): Uint8Array<ArrayBuffer> =>
  concat(
    utf8("pln-1"),
    [0],
    utf8(String(place.kind)),
    [0],
    utf8(place.v),
    [0],
    utf8(place.d ?? ""),
    [0],
    utf8(place.pubkey),
  )

const aesKey = (key: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", concat(key), "AES-GCM", false, [usage])

const through = async (bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await new Response(new Blob([concat(bytes)]).stream().pipeThrough(stream)).arrayBuffer())

export const deflate = (bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => through(bytes, new CompressionStream("deflate-raw"))

const inflate = async (bytes: Uint8Array): Promise<Result<Uint8Array<ArrayBuffer>, OpenError>> =>
  through(bytes, new DecompressionStream("deflate-raw")).then(
    (inflated) => Ok(inflated),
    () => Err({ type: "not-inflatable" }),
  )

/** Seals bytes as they are, with the nonce given: the caller draws it at random. */
export const sealBytes = async (
  key: Uint8Array,
  nonce: Uint8Array,
  place: Place,
  bytes: Uint8Array,
): Promise<Result<string, PadError>> => {
  const padded = pad(bytes)
  if (!padded.ok) return padded
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: concat(nonce), additionalData: aad(place) },
    await aesKey(key, "encrypt"),
    padded.value,
  )
  return Ok(toBase64(concat([VERSION], nonce, new Uint8Array(sealed))))
}

/** Seals a value as JSON, deflated. */
export const sealJson = async (key: Uint8Array, nonce: Uint8Array, place: Place, value: unknown): Promise<Result<string, PadError>> =>
  sealBytes(key, nonce, place, await deflate(utf8(JSON.stringify(value))))

const decoded = (content: string): Result<Uint8Array<ArrayBuffer>, OpenError> =>
  /^[A-Za-z0-9+/]*={0,2}$/.test(content) ? Ok(fromBase64(content)) : Err({ type: "not-base64" })

export const openBytes = async (key: Uint8Array, place: Place, content: string): Promise<Result<Uint8Array<ArrayBuffer>, OpenError>> => {
  const box = decoded(content)
  if (!box.ok) return box
  if (box.value[0] !== VERSION) return Err({ type: "unknown-version", version: box.value[0] })
  const nonce = box.value.subarray(1, 1 + NONCE_LENGTH)
  const opened = await aesKey(key, "decrypt")
    .then((aes) => crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(place) }, aes, box.value.subarray(1 + NONCE_LENGTH)))
    .then(
      (plain) => Ok(new Uint8Array(plain)),
      () => Err({ type: "does-not-open" } as const),
    )
  return opened.ok ? unpad(opened.value) : opened
}

const parsed = (bytes: Uint8Array): Result<unknown, OpenError> => {
  try {
    return Ok(JSON.parse(fromUtf8(bytes)))
  } catch {
    return Err({ type: "not-json" })
  }
}

export const openJson = async (key: Uint8Array, place: Place, content: string): Promise<Result<unknown, OpenError>> => {
  const bytes = await openBytes(key, place, content)
  if (!bytes.ok) return bytes
  const inflated = await inflate(bytes.value)
  return inflated.ok ? parsed(inflated.value) : inflated
}
