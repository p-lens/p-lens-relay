import { expect, test } from "bun:test";
import { change, LARGEST_PADDED } from "../src/pln";
import { connect, newWriter, nowSeconds, publish, relayInformation } from "../src/relay";

test("the relay describes itself by NIP-11", async () => {
  const information = await relayInformation();
  console.log(JSON.stringify(information, undefined, 2));
  expect(typeof information).toBe("object");
});

test("the largest seal PLN-1 makes is taken", async () => {
  const relay = await connect();
  const event = change(newWriter(), "largest", nowSeconds(), "largest", LARGEST_PADDED);
  console.log(`the largest seal's event: ${JSON.stringify(event).length} bytes`);
  expect(await publish(relay, event)).toEqual({ type: "accepted" });
  relay.close();
}, 30_000);
