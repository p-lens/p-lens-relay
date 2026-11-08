import { admit, emptyStore, query, RULES, type Admission, type Filter, type NostrEvent, type Store } from "@p-lens-relay/core"
import { signed, writer } from "@p-lens-relay/core/testing"
import { KIND } from "@p-lens-relay/gate"
import { EXPIRY, opaque, sealedContent } from "@p-lens-relay/gate/testing"
import { describe, expect, test } from "bun:test"
import { admitInto, queryFrom } from "../src/storage/events"
import { bucketSql } from "./sqlite"

/** A seeded draw, so that every run makes the same events. */
const draws = (seed: number) => {
  const held = { seed }
  return (count: number): number => {
    held.seed = (Math.imul(held.seed, 1_103_515_245) + 12_345) >>> 0
    return (held.seed >>> 8) % count
  }
}

const WRITERS = [writer(1), writer(2), writer(3)]
const LINES = [opaque(1), opaque(2), opaque(3)]
const ADDRESSES = [opaque(11), opaque(12)]

/** An ephemeral kind, which no store keeps: PLN-1 writes none of its own, but a relay passes any on. */
const EPHEMERAL = 20_000

const pick = <T>(draw: (count: number) => number, from: readonly T[]): T => from[draw(from.length)] as T

/** Events as clients write them, many in the same second, some versions of one address, some deleting others, some sent again. */
const eventsOf = (seed: number, count: number): readonly NostrEvent[] => {
  const draw = draws(seed)
  return Array.from({ length: count }).reduce<readonly NostrEvent[]>((made, _, index) => {
    const by = pick(draw, WRITERS)
    const created_at = 1_000 + draw(6)
    const v = pick(draw, LINES)
    const content = sealedContent()
    const kinds = [
      () => signed(by, { kind: KIND.bookChange, created_at, tags: [["v", v]], content: sealedContent(32 + 32 * (index % 3)) }),
      () => signed(by, { kind: KIND.tip, created_at, tags: [["v", v], ["d", pick(draw, ADDRESSES)]], content: sealedContent(32 + 32 * (index % 5)) }),
      () => signed(by, { kind: KIND.playCopy, created_at, tags: [["v", v], ["d", pick(draw, ADDRESSES)], ["expiration", EXPIRY]], content }),
      () => signed(by, { kind: EPHEMERAL, created_at, tags: [["v", v], ["d", pick(draw, ADDRESSES)]], content }),
      () => {
        const own = made.filter((event) => event.pubkey === by.pubkey)
        const target = own.length === 0 || draw(4) === 0 ? pick(draw, [...made, undefined]) : pick(draw, own)
        return signed(by, { kind: KIND.deletion, created_at, tags: [["e", target?.id ?? "f".repeat(64)]], content: "" })
      },
      () => (made.length === 0 ? signed(by, { kind: KIND.bookChange, created_at, tags: [["v", v]], content }) : pick(draw, made)),
    ]
    return [...made, pick(draw, kinds)()]
  }, [])
}

const FILTERS: readonly (readonly Filter[])[] = [
  [{}],
  [{ "#v": [opaque(1)] }],
  [{ "#v": [opaque(2), opaque(3)], limit: 7 }],
  [{ kinds: [KIND.tip], "#d": [opaque(11)] }],
  [{ authors: [writer(2).pubkey], since: 1_002, until: 1_004 }],
  [{ kinds: [KIND.deletion], "#e": ["f".repeat(64)] }],
  [{ "#v": [opaque(1)], limit: 3 }, { authors: [writer(1).pubkey], limit: 4 }],
  [{ ids: [] }],
]

/** Every way an event is taken or refused, each of which every run meets. */
const EVERY_ADMISSION = [
  '{"type":"deleted"}',
  '{"type":"duplicate"}',
  '{"type":"have-newer"}',
  '{"type":"passed"}',
  '{"type":"stored","replaced":"some"}',
  '{"type":"stored"}',
]

const stripped = (admission: Admission): unknown =>
  admission.type === "stored" ? { type: "stored", replaced: admission.replaced?.id } : admission

const ids = (events: readonly NostrEvent[]): readonly string[] => events.map((event) => event.id)

describe("the relay over SQLite and the relay core in memory", () => {
  test.each([1, 2, 3, 4, 5, 6, 7, 8])("take in and find the same events, run %d", (seed) => {
    const sql = bucketSql()
    const events = eventsOf(seed, 120)
    const remembered = events.reduce<{ store: Store; admissions: unknown[] }>(
      (sofar, event) => {
        const { store, admission } = admit(RULES.tie, sofar.store, event)
        return { store, admissions: [...sofar.admissions, stripped(admission)] }
      },
      { store: emptyStore, admissions: [] },
    )
    expect(events.map((event) => stripped(admitInto(sql, RULES.tie, event)))).toEqual(remembered.admissions)
    const kinds = new Set(remembered.admissions.map((admission) => JSON.stringify(admission).replace(/"replaced":"[0-9a-f]+"/, '"replaced":"some"')))
    expect([...kinds].sort()).toEqual(EVERY_ADMISSION)
    FILTERS.forEach((filters) => {
      expect(ids(queryFrom(sql, filters, RULES, 1_000))).toEqual(ids(query(remembered.store, filters, RULES.defaultLimit, RULES.maxLimit, 1_000)))
    })
  })

  test("agree on what has expired", () => {
    const sql = bucketSql()
    const events = eventsOf(9, 60)
    const store = events.reduce<Store>((sofar, event) => admit(RULES.tie, sofar, event).store, emptyStore)
    events.forEach((event) => admitInto(sql, RULES.tie, event))
    const after = Number(EXPIRY)
    expect(ids(queryFrom(sql, [{}], RULES, after))).toEqual(ids(query(store, [{}], RULES.defaultLimit, RULES.maxLimit, after)))
    expect(queryFrom(sql, [{ kinds: [KIND.playCopy] }], RULES, after)).toEqual([])
  })

  test("agree when the tie keeps whichever came first", () => {
    const sql = bucketSql()
    const tie = "first-arrival"
    const events = eventsOf(10, 120)
    const store = events.reduce<Store>((sofar, event) => admit(tie, sofar, event).store, emptyStore)
    events.forEach((event) => admitInto(sql, tie, event))
    expect(ids(queryFrom(sql, [{}], RULES, 1_000))).toEqual(ids(query(store, [{}], RULES.defaultLimit, RULES.maxLimit, 1_000)))
  })
})
