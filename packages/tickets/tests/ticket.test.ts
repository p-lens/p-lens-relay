import { describe, expect, test } from "bun:test"
import { blindTicket, finishTicket, infoOf, infoText, nextPeriod, periodOf, readTicket, signBlinded, type TicketInfo } from "../src"
import { testKeys } from "../src/testing"

const keys = await testKeys()
const SYNC: TicketInfo = { product: "sync", cap: 1, period: "2026-11" }

const value = <T>(outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly type: string } }): T => {
  if (!outcome.ok) throw new Error(outcome.error.type)
  return outcome.value
}

const issued = async (info: TicketInfo): Promise<string> => {
  const pending = value(await blindTicket(keys.publicKey, info))
  return value(await finishTicket(keys.publicKey, pending, value(await signBlinded(keys.privateKey, pending.blinded, info))))
}

describe("public information", () => {
  test("is read back as it was written", () => {
    const info: TicketInfo = { product: "sending", cap: 200, period: "2027-01" }
    expect(infoText(info)).toBe("pln-1;product=sending;cap=200;period=2027-01")
    expect(infoOf(infoText(info))).toEqual(info)
  })

  test.each([
    "pln-1;product=sync;cap=0;period=2026-11",
    "pln-1;product=sync;cap=01;period=2026-11",
    "pln-1;product=gold;cap=1;period=2026-11",
    "pln-1;product=sync;cap=1;period=2026-13",
    "pln-1;product=sync;cap=1;period=2026-11;extra=1",
    "pln-2;product=sync;cap=1;period=2026-11",
    "pln-1;cap=1;product=sync;period=2026-11",
  ])("refuses %s", (text) => {
    expect(infoOf(text)).toBeUndefined()
  })

  test("names months in UTC", () => {
    expect(periodOf(Date.UTC(2026, 10, 30, 23, 59) / 1000)).toBe("2026-11")
    expect(nextPeriod("2026-11")).toBe("2026-12")
    expect(nextPeriod("2026-12")).toBe("2027-01")
  })
})

describe("a ticket", () => {
  test("is read by the issuer's public key as what it pays for", async () => {
    const read = await readTicket(keys.publicKey, await issued(SYNC))
    expect(read?.info).toEqual(SYNC)
    expect(read?.key).toMatch(/^[0-9a-f]{64}$/)
  })

  test("is known by a key of its own", async () => {
    const [first, second] = await Promise.all([issued(SYNC), issued(SYNC)])
    expect((await readTicket(keys.publicKey, first))?.key).not.toBe((await readTicket(keys.publicKey, second))?.key)
  })

  test("never shows the issuer its message", async () => {
    const pending = value(await blindTicket(keys.publicKey, SYNC))
    const blinded = Buffer.from(pending.blinded).toString("hex")
    expect(blinded.includes(Buffer.from(pending.message.subarray(0, 16)).toString("hex"))).toBe(false)
    expect(blinded.includes(Buffer.from(pending.message.subarray(32, 48)).toString("hex"))).toBe(false)
  })

  test("cannot be finished from a signature under public information other than its own", async () => {
    const pending = value(await blindTicket(keys.publicKey, SYNC))
    const other = value(await signBlinded(keys.privateKey, pending.blinded, { ...SYNC, cap: 9 }))
    expect(await finishTicket(keys.publicKey, pending, other)).toEqual({ ok: false, error: { type: "invalid-signature" } })
  })

  test("does not hold with its information changed afterwards", async () => {
    const [, message, signature] = (await issued({ product: "sharing", cap: 2, period: "2026-11" })).split(".")
    const raised = Buffer.from("pln-1;product=sharing;cap=30;period=2026-11").toString("base64url")
    expect(await readTicket(keys.publicKey, [raised, message, signature].join("."))).toBeUndefined()
  })

  test("does not hold with its message changed", async () => {
    const [info, message, signature] = (await issued(SYNC)).split(".") as [string, string, string]
    const changed = Buffer.from(message, "base64url")
    changed[40] = (changed[40] ?? 0) ^ 1
    expect(await readTicket(keys.publicKey, [info, changed.toString("base64url"), signature].join("."))).toBeUndefined()
  })

  test.each(["", "a.b", "a.b.c.d", "!!.??.**", "cGxuLTE.AAAA.AAAA"])("is not read from %p", async (claim) => {
    expect(await readTicket(keys.publicKey, claim)).toBeUndefined()
  })

  test("fits the claim tag the gate takes", async () => {
    expect((await issued({ product: "huddles", cap: 30, period: "2026-12" })).length).toBeLessThanOrEqual(2_048)
  })
})
