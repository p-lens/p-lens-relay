import type { NostrEvent } from "@p-lens-relay/core"
import { writer } from "@p-lens-relay/core/testing"
import { bookChange, NOW, redemption } from "@p-lens-relay/gate/testing"
import { blindTicket, finishTicket, signBlinded, type TicketInfo } from "@p-lens-relay/tickets"
import { testKeys } from "@p-lens-relay/tickets/testing"
import { describe, expect, test } from "bun:test"
import { HELD_IN_PROCESS, receive, type Bucket } from "../src/session"
import { settingsOf } from "../src/settings"
import { ticketReaderOf } from "../src/ticket-reader"
import { bucketSql } from "./sqlite"

const keys = await testKeys()
const owner = writer(1)

const value = <T>(outcome: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly type: string } }): T => {
  if (!outcome.ok) throw new Error(outcome.error.type)
  return outcome.value
}

/** A ticket made as a device and the issuer make one: blinded, signed blind, finished. */
const ticket = async (info: TicketInfo): Promise<string> => {
  const pending = value(await blindTicket(keys.publicKey, info))
  return value(await finishTicket(keys.publicKey, pending, value(await signBlinded(keys.privateKey, pending.blinded, info))))
}

const gatedBucket = (keyText: string, warnings: string[] = []): Bucket => {
  const read = settingsOf({ ENTITLEMENT: "gated", ISSUER_URL: "https://issuer.example.com", ISSUER_PUBLIC_KEY: keyText })
  if (!read.ok) throw new Error("the gated settings are read")
  return { sql: bucketSql(), settings: read.value, readTicket: ticketReaderOf(keyText, (text) => warnings.push(text)), holding: HELD_IN_PROCESS, held: { sockets: new Map(), spilled: new Set(), subscriptions: undefined } }
}

const answer = async (bucket: Bucket, event: NostrEvent): Promise<readonly [boolean, string] | undefined> => {
  const out = await receive(bucket, "writer", JSON.stringify(["EVENT", event]), NOW)
  const ok = out.find((message) => message.message[0] === "OK")?.message
  return ok?.[0] === "OK" ? [ok[2], ok[3]] : undefined
}

describe("a gated relay reading real tickets", () => {
  test("opens a book's line on a ticket the issuer signed, once", async () => {
    const bucket = gatedBucket(keys.publicText)
    const claim = await ticket({ product: "sync", cap: 1, period: "2026-11" })
    expect(await answer(bucket, bookChange(owner))).toEqual([false, "restricted: pass-required for sync"])
    expect(await answer(bucket, redemption(owner, claim))).toEqual([true, ""])
    expect(await answer(bucket, bookChange(owner))).toEqual([true, ""])
    expect(await answer(bucket, redemption(writer(2), claim))).toEqual([false, "invalid: ticket already redeemed"])
  })

  test("refuses a ticket whose information was raised after signing", async () => {
    const bucket = gatedBucket(keys.publicText)
    const [, message, signature] = (await ticket({ product: "sharing", cap: 2, period: "2026-11" })).split(".")
    const raised = btoa("pln-1;product=sharing;cap=30;period=2026-11").replaceAll("=", "")
    expect(await answer(bucket, redemption(owner, [raised, message, signature].join(".")))).toEqual([false, "invalid: ticket"])
  })

  test("refuses every ticket, and says so, when the issuer's key cannot be read", async () => {
    const warnings: string[] = []
    const bucket = gatedBucket("bm90IGEga2V5", warnings)
    expect(await answer(bucket, redemption(owner, await ticket({ product: "sync", cap: 1, period: "2026-11" })))).toEqual([false, "invalid: ticket"])
    await Promise.resolve()
    expect(warnings).toEqual(["ISSUER_PUBLIC_KEY cannot be read: every ticket is refused"])
  })
})
