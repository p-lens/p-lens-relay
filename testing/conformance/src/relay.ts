import { Relay } from "nostr-tools/relay";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Event, EventTemplate, Filter } from "nostr-tools";

/** The relay under test, named by RELAY_URL. */
export const relayUrl = process.env.RELAY_URL ?? "ws://127.0.0.1:7777";

/** A writer with keys of its own, so that runs never see each other's events. */
export type Writer = { readonly secret: Uint8Array; readonly pubkey: string };

export const newWriter = (): Writer => {
  const secret = generateSecretKey();
  return { secret, pubkey: getPublicKey(secret) };
};

export const signed = (writer: Writer, template: EventTemplate): Event =>
  finalizeEvent(template, writer.secret);

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const connect = (): Promise<Relay> => Relay.connect(relayUrl);

export type Published = { readonly type: "accepted" } | { readonly type: "refused"; readonly reason: string };

export const publish = async (relay: Relay, event: Event): Promise<Published> => {
  try {
    await relay.publish(event);
    return { type: "accepted" };
  } catch (reason) {
    return { type: "refused", reason: String(reason).slice(0, 120) };
  }
};

/** Every stored event a filter matches, up to the relay's end of stored events. */
export const fetchStored = (relay: Relay, filters: Filter[]): Promise<Event[]> =>
  new Promise((resolve) => {
    const events: Event[] = [];
    const subscription = relay.subscribe(filters, {
      onevent: (event) => events.push(event),
      oneose: () => {
        subscription.close();
        resolve(events);
      },
    });
  });

const oldestOf = (events: Event[]): number =>
  events.reduce((oldest, event) => Math.min(oldest, event.created_at), Number.POSITIVE_INFINITY);

const idsOf = (events: Event[]): Set<string> => new Set(events.map((event) => event.id));

/**
 * Catch-up as a client must do it on a relay that caps a page: pages walked
 * back by `until`, the boundary second asked again and its events told apart
 * by id. It stops when a page brings nothing new.
 */
export const fetchCaughtUp = async (relay: Relay, filter: Filter, page: number): Promise<Event[]> => {
  const walk = async (until: number | undefined, held: Map<string, Event>): Promise<Map<string, Event>> => {
    const events = await fetchStored(relay, [{ ...filter, limit: page, ...(until === undefined ? {} : { until }) }]);
    const fresh = events.filter((event) => !held.has(event.id));
    if (fresh.length === 0) return held;
    const next = new Map([...held, ...fresh.map((event) => [event.id, event] as const)]);
    return walk(oldestOf(events), next);
  };
  return [...(await walk(undefined, new Map())).values()];
};

export const sameIds = (left: Event[], right: Event[]): boolean => {
  const ids = idsOf(left);
  return left.length === right.length && right.every((event) => ids.has(event.id));
};

/** The relay's NIP-11 document, read over HTTP at the relay's own address. */
export const relayInformation = async (): Promise<Record<string, unknown>> => {
  const url = relayUrl.replace(/^ws/, "http");
  const response = await fetch(url, { headers: { Accept: "application/nostr+json" } });
  return (await response.json()) as Record<string, unknown>;
};

/** Puts an event and fails the test at once if the relay refuses it. */
export const accepted = async (relay: Relay, event: Event): Promise<void> => {
  const outcome = await publish(relay, event);
  if (outcome.type === "refused") throw new Error(`refused: ${outcome.reason}`);
};
