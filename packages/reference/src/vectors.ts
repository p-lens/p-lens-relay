import { fromHex, toHex, utf8, concat } from "./bytes"
import { address, derive, locator, sealKey, signingKey } from "./derive"
import { paddedLength } from "./pad"
import { deflate, sealBytes, type Place } from "./seal"

/** The fixed inputs the test vectors are worked out from. */
export const INPUTS = {
  sync: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  epoch: "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
  invitation: "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
  huddle: "606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f",
  device: "808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f",
  day: "2026-11-04",
  playId: "019a4e5c-7b10-7000-8000-000000000001",
  nonce: "a0a1a2a3a4a5a6a7a8a9aaab",
  sealed: { parlor: "パチンコ ネルフ 第3新東京店", machine: "テスト機 A", tokens: 12_345, yen: -15_000 },
  paddedLengths: [1, 32, 33, 64, 65, 100, 256, 257, 1000, 1024, 1025, 4096, 4097, 16_384, 16_385, 32_000],
} as const

export type Vectors = Awaited<ReturnType<typeof vectorsFrom>>

const keyPair = async (secret: Uint8Array, name: string) => {
  const key = await signingKey(secret, name)
  return { name, counter: key.counter, secret: toHex(key.secret), pubkey: key.pubkey }
}

/** Every PLN-1 derivation and a seal, worked out from the inputs: what another implementation checks itself against. */
export const vectorsFrom = async (inputs: typeof INPUTS) => {
  const sync = fromHex(inputs.sync)
  const epoch = fromHex(inputs.epoch)
  const invitation = fromHex(inputs.invitation)
  const huddle = fromHex(inputs.huddle)
  const device = fromHex(inputs.device)
  const participantRoot = await derive(huddle, concat(utf8("device:"), device))
  const owner = await keyPair(sync, "owner")
  const bookKey = await sealKey(epoch, "book")
  const place: Place = { kind: 34739, v: await locator(sync, `plays:${inputs.day}`), d: await address(sync, `copy:${inputs.playId}:1:device`), pubkey: owner.pubkey }
  const compressed = await deflate(utf8(JSON.stringify(inputs.sealed)))
  const playsKey = await sealKey(sync, `plays:${inputs.day}`)
  const content = await sealBytes(playsKey, fromHex(inputs.nonce), place, compressed)
  return {
    derive: { secret: inputs.sync, label: "owner", output: toHex(await derive(sync, "owner")) },
    keys: {
      owner,
      member: await keyPair(invitation, "member"),
      sender: await keyPair(invitation, "sender"),
      participant: { root: toHex(participantRoot), ...(await keyPair(participantRoot, `participant:${inputs.day}`)) },
    },
    sealKeys: {
      vault: toHex(await sealKey(sync, "vault")),
      book: toHex(bookKey),
      plays: toHex(playsKey),
      mailbox: toHex(await sealKey(invitation, "mailbox")),
      inbox: toHex(await sealKey(invitation, "inbox")),
      huddle: toHex(await sealKey(huddle, `huddle:${inputs.day}`)),
    },
    lines: {
      book: await locator(epoch, "book"),
      plays: place.v,
      inbox: await locator(sync, "inbox"),
      access: await locator(sync, "access"),
      mailbox: await locator(invitation, "mailbox"),
      huddle: await locator(huddle, `huddle:${inputs.day}`),
    },
    addresses: {
      tip: await address(epoch, `tip:${owner.pubkey}:${inputs.device.slice(0, 32)}`),
      sharing: await address(sync, "sharing"),
      sending: await address(sync, "sending"),
      mailbox: await address(invitation, "mailbox"),
      copy: place.d,
      sent: await address(invitation, `play:${inputs.playId}`),
    },
    paddedLengths: inputs.paddedLengths.map((length) => ({ length, padded: paddedLength(length) })),
    seal: {
      key: toHex(playsKey),
      nonce: inputs.nonce,
      place,
      json: JSON.stringify(inputs.sealed),
      compressed: toHex(compressed),
      content: content.ok ? content.value : `error: ${content.error.type}`,
    },
  }
}
