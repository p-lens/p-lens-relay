import { expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import { change, copy, KIND, markerOf } from "../src/pln";
import { accepted, connect, fetchStored, newWriter, nowSeconds } from "../src/relay";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an event put while subscribed arrives at once", async () => {
  const reader = await connect();
  const writerRelay = await connect();
  const writer = newWriter();
  const arrived: Event[] = [];
  const subscription = reader.subscribe([{ kinds: [KIND.copy], authors: [writer.pubkey], since: nowSeconds() - 5 }], {
    onevent: (event) => arrived.push(event),
  });
  await settle(200);
  const sentAt = performance.now();
  await accepted(writerRelay, copy(writer, "live", nowSeconds(), "spin"));
  while (arrived.length === 0 && performance.now() - sentAt < 3000) await settle(10);
  expect(arrived.length).toBe(1);
  expect(performance.now() - sentAt).toBeLessThan(1000);
  subscription.close();
  reader.close();
  writerRelay.close();
});

test("what was put while closed comes back on reopening", async () => {
  const writer = newWriter();
  const first = await connect();
  const before = nowSeconds() - 50;
  await accepted(first, change(writer, "line", before, "seen"));
  const seen = await fetchStored(first, [{ kinds: [KIND.change], authors: [writer.pubkey] }]);
  first.close();

  const other = await connect();
  const missed = [1, 2, 3, 4, 5].map((step) =>
    change(writer, "line", before + step, `missed ${step}`),
  );
  for (const event of missed) await accepted(other, event);
  other.close();

  const reopened = await connect();
  const lastSeen = Math.max(...seen.map((event) => event.created_at));
  const back = await fetchStored(reopened, [{ kinds: [KIND.change], authors: [writer.pubkey], since: lastSeen }]);
  const seenIds = new Set(seen.map((event) => event.id));
  expect(back.filter((event) => !seenIds.has(event.id)).map(markerOf).sort()).toEqual(
    missed.map(markerOf).sort(),
  );
  reopened.close();
});
