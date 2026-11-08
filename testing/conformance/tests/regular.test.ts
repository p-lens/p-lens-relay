import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Relay } from "nostr-tools/relay";
import { change, KIND, opaqueOf } from "../src/pln";
import { accepted, connect, fetchCaughtUp, fetchStored, newWriter, nowSeconds, sameIds } from "../src/relay";

const held: { relay: Relay | undefined } = { relay: undefined };
const relay = (): Relay => held.relay as Relay;

beforeAll(async () => {
  held.relay = await connect();
});
afterAll(() => relay().close());

const commits = (count: number, perSecond: number, line: string) => {
  const writer = newWriter();
  const base = nowSeconds() - 10_000;
  const events = Array.from({ length: count }, (_, index) => change(writer, line, base + Math.floor(index / perSecond), `commit ${index}`));
  return { writer, events };
};

test("regular events are all kept and all come back by catch-up", async () => {
  const { writer, events } = commits(300, 3, "line-a");
  for (const event of events) await accepted(relay(), event);
  const back = await fetchCaughtUp(relay(), { kinds: [KIND.change], authors: [writer.pubkey] }, 100);
  expect(sameIds(events, back)).toBe(true);
}, 60_000);

test("catch-up from a point gives exactly what came after it", async () => {
  const { writer, events } = commits(60, 1, "line-b");
  for (const event of events) await accepted(relay(), event);
  const seenUpTo = events[29]?.created_at ?? 0;
  const back = await fetchCaughtUp(relay(), { kinds: [KIND.change], authors: [writer.pubkey], since: seenUpTo + 1 }, 100);
  expect(sameIds(events.slice(30), back)).toBe(true);
}, 60_000);

/**
 * Paging by `until` cannot pass a second holding more events than a page:
 * the relay returns the same page again. A line must never be written that
 * densely; this measures where the relay stands.
 */
test("a second holding more events than a page is reported", async () => {
  const { writer, events } = commits(150, 150, "line-c");
  for (const event of events) await accepted(relay(), event);
  const back = await fetchCaughtUp(relay(), { kinds: [KIND.change], authors: [writer.pubkey] }, 100);
  console.log(`one second, 150 events, pages of 100: ${back.length} caught up`);
  expect(back.length).toBeGreaterThanOrEqual(100);
}, 60_000);

test("a filter by tag finds a line's commits and no other's", async () => {
  const { writer, events } = commits(10, 10, "line-d");
  for (const event of events) await accepted(relay(), event);
  const back = await fetchStored(relay(), [{ kinds: [KIND.change], "#v": [opaqueOf("line-d")], authors: [writer.pubkey] }]);
  expect(sameIds(events, back)).toBe(true);
});
