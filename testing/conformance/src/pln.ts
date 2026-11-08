import { createHash } from "node:crypto";
import type { Event } from "nostr-tools";
import { signed, type Writer } from "./relay";

/**
 * Events shaped as PLN-1 shapes them (PROTOCOL.md §3, §4), so that the tests
 * run against a P-Lens relay, which refuses any other, as well as any plain
 * Nostr relay: a book's change (regular) and a play's copy (addressable).
 */
export const KIND = { change: 4738, copy: 34739 } as const;

/** A `v` or `d` from a name: 32 lowercase hex digits that mean nothing to the relay. */
export const opaqueOf = (name: string): string => createHash("sha256").update(name).digest("hex").slice(0, 32);

/** NIP-44 v2's padded length, as PROTOCOL.md §3.3 pads a seal. */
const paddedLength = (length: number): number => {
  if (length <= 32) return 32;
  const nextPower = 2 ** (Math.floor(Math.log2(length - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((length - 1) / chunk) + 1);
};

/** The largest padded plaintext a seal carries. */
export const LARGEST_PADDED = paddedLength(32_000);

/**
 * Content shaped as a seal, carrying a marker the tests read back where the
 * plaintext would be; nothing is encrypted, as the relay cannot tell.
 */
export const sealed = (marker: string, padded = paddedLength(new TextEncoder().encode(marker).length)): string => {
  const text = new TextEncoder().encode(marker);
  const bytes = new Uint8Array(1 + 12 + 2 + padded + 16);
  bytes[0] = 1;
  bytes[13] = text.length >> 8;
  bytes[14] = text.length & 0xff;
  bytes.set(text, 15);
  return Buffer.from(bytes).toString("base64");
};

export const markerOf = (event: Event): string => {
  const bytes = Buffer.from(event.content, "base64");
  const length = ((bytes[13] ?? 0) << 8) | (bytes[14] ?? 0);
  return new TextDecoder().decode(bytes.subarray(15, 15 + length));
};

const DAY = 86_400;

/** An expiry two whole UTC days ahead, as a client rounds one. */
const expiry = (): string => String((Math.floor(Date.now() / 1000 / DAY) + 3) * DAY);

export const change = (writer: Writer, line: string, created_at: number, marker: string, padded?: number): Event =>
  signed(writer, { kind: KIND.change, created_at, tags: [["v", opaqueOf(line)]], content: sealed(marker, padded) });

export const copy = (writer: Writer, address: string, created_at: number, marker: string): Event =>
  signed(writer, {
    kind: KIND.copy,
    created_at,
    tags: [["v", opaqueOf("plays")], ["d", opaqueOf(address)], ["expiration", expiry()]],
    content: sealed(marker),
  });
