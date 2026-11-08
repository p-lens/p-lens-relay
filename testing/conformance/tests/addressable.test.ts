import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Relay } from "nostr-tools/relay";
import { copy, KIND, markerOf, opaqueOf } from "../src/pln";
import { accepted, connect, fetchStored, newWriter, nowSeconds, publish, type Writer } from "../src/relay";

const held: { relay: Relay | undefined } = { relay: undefined };
const relay = (): Relay => held.relay as Relay;

beforeAll(async () => {
  held.relay = await connect();
});
afterAll(() => relay().close());

const state = copy;

const latestOf = (writer: Writer, d: string) => fetchStored(relay(), [{ kinds: [KIND.copy], authors: [writer.pubkey], "#d": [opaqueOf(d)] }]);

test("an addressable event is kept as its latest version alone", async () => {
  const writer = newWriter();
  const base = nowSeconds() - 100;
  for (const step of [0, 1, 2]) await accepted(relay(), state(writer, "play-a", base + step, `v${step}`));
  const stored = await latestOf(writer, "play-a");
  expect(stored.map(markerOf)).toEqual(["v2"]);
});

test("an older version arriving after a newer one does not replace it", async () => {
  const writer = newWriter();
  const base = nowSeconds() - 100;
  await accepted(relay(), state(writer, "play-b", base + 5, "newer"));
  await publish(relay(), state(writer, "play-b", base, "older"));
  const stored = await latestOf(writer, "play-b");
  expect(stored.map(markerOf)).toEqual(["newer"]);
});

test.each([
  ["higher id first", "higher-first"],
  ["lower id first", "lower-first"],
] as const)("two versions in one second keep the one with the lower id, the %s", async (_, order) => {
  const writer = newWriter();
  const second = nowSeconds() - 100;
  const [lower, higher] = [state(writer, "play-c", second, "x"), state(writer, "play-c", second, "y")].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  if (lower === undefined || higher === undefined) throw new Error("two versions were made");
  for (const version of order === "higher-first" ? [higher, lower] : [lower, higher]) await publish(relay(), version);
  const stored = await latestOf(writer, "play-c");
  expect(stored.map((event) => event.id)).toEqual([lower.id]);
});

test("every play's latest state comes back at once in one request", async () => {
  const writer = newWriter();
  const base = nowSeconds() - 100;
  const plays = Array.from({ length: 20 }, (_, index) => `play-${index}`);
  for (const d of plays) {
    await accepted(relay(), state(writer, d, base, "first"));
    await accepted(relay(), state(writer, d, base + 1, "latest"));
  }
  const stored = await fetchStored(relay(), [{ kinds: [KIND.copy], authors: [writer.pubkey] }]);
  expect(stored.length).toBe(plays.length);
  expect(stored.every((event) => markerOf(event) === "latest")).toBe(true);
});
