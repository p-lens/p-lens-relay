import { memorySql } from "@p-lens-relay/sql/testing"
import { blindTicket, finishTicket, fromBase64, infoText, readTicket, toBase64, type TicketInfo } from "@p-lens-relay/tickets"
import { testKeys } from "@p-lens-relay/tickets/testing"
import { describe, expect, test } from "bun:test"
import { isOperator } from "../src/admin"
import { issue, makePlan, type Issuing } from "../src/issuing"
import { prepare } from "../src/storage"

const keys = await testKeys()
const MID_NOVEMBER = Date.UTC(2026, 10, 15) / 1000

const issuingOf = (key = keys.privateKey): Issuing => ({ sql: memorySql(prepare), privateKey: async () => key })

const planned = async (issuing: Issuing, items: unknown[] = [{ product: "sync", cap: 1, perMonth: 2 }]): Promise<string> => {
  const made = await makePlan(issuing, { items, starts: "2026-11", months: 1 })
  expect(made.status).toBe(201)
  return (made.body as { code: string }).code
}

/** Asks for tickets as a device does: blinded, sent with the code, finished from what comes back. */
const asked = async (issuing: Issuing, code: string, infos: readonly TicketInfo[], now = MID_NOVEMBER) => {
  const pending = await Promise.all(infos.map(async (info) => {
    const blinded = await blindTicket(keys.publicKey, info)
    if (!blinded.ok) throw new Error(blinded.error.type)
    return blinded.value
  }))
  const answer = await issue(issuing, { code, tickets: pending.map((one) => ({ info: infoText(one.info), blinded: toBase64(one.blinded) })) }, now)
  const signatures = (answer.body as { signatures?: string[] }).signatures
  const claims = signatures === undefined ? [] : await Promise.all(pending.map(async (one, index) => {
    const finished = await finishTicket(keys.publicKey, one, fromBase64(signatures[index] ?? "") ?? new Uint8Array())
    if (!finished.ok) throw new Error(finished.error.type)
    return finished.value
  }))
  return { answer, claims }
}

const SYNC: TicketInfo = { product: "sync", cap: 1, period: "2026-11" }

describe("the issuer", () => {
  test("issues tickets on a plan that the relay reads as what they pay for", async () => {
    const issuing = issuingOf()
    const code = await planned(issuing)
    const { answer, claims } = await asked(issuing, code, [SYNC, SYNC])
    expect(answer.status).toBe(200)
    const read = await Promise.all(claims.map((claim) => readTicket(keys.publicKey, claim)))
    expect(read.map((ticket) => ticket?.info)).toEqual([SYNC, SYNC])
  })

  test("takes the code however it is typed", async () => {
    const issuing = issuingOf()
    const code = await planned(issuing)
    expect((await asked(issuing, code.toLowerCase().replaceAll("-", " "), [SYNC])).answer.status).toBe(200)
  })

  test("gives no more than the plan's month holds, across requests", async () => {
    const issuing = issuingOf()
    const code = await planned(issuing)
    expect((await asked(issuing, code, [SYNC])).answer.status).toBe(200)
    expect((await asked(issuing, code, [SYNC, SYNC])).answer).toEqual({
      status: 400,
      body: { error: { type: "too-many", product: "sync", cap: 1, period: "2026-11", left: 1 } },
    })
    expect((await asked(issuing, code, [SYNC])).answer.status).toBe(200)
    expect((await asked(issuing, code, [SYNC])).answer.status).toBe(400)
  })

  test("gives no more than the month holds to requests at once", async () => {
    const issuing = issuingOf()
    const code = await planned(issuing)
    const answers = await Promise.all([asked(issuing, code, [SYNC]), asked(issuing, code, [SYNC]), asked(issuing, code, [SYNC])])
    expect(answers.map(({ answer }) => answer.status).sort()).toEqual([200, 200, 400])
  })

  test("refuses a code no plan has", async () => {
    expect((await asked(issuingOf(), "0".repeat(26), [SYNC])).answer).toEqual({ status: 404, body: { error: { type: "unknown-plan" } } })
  })

  test("gives the count back when a blinded message cannot be signed", async () => {
    const issuing = issuingOf()
    const code = await planned(issuing)
    const tooLarge = toBase64(new Uint8Array(keys.privateKey.bytes).fill(0xff))
    expect((await issue(issuing, { code, tickets: [{ info: infoText(SYNC), blinded: tooLarge }] }, MID_NOVEMBER)).status).toBe(400)
    expect((await asked(issuing, code, [SYNC, SYNC])).answer.status).toBe(200)
  })

  test.each([
    ["nothing", undefined],
    ["no tickets", { code: "0".repeat(26) }],
    ["information it does not write", { code: "0".repeat(26), tickets: [{ info: "pln-1;product=gold;cap=1;period=2026-11", blinded: "AAAA" }] }],
    ["a blinded message not in base64", { code: "0".repeat(26), tickets: [{ info: infoText(SYNC), blinded: "**" }] }],
  ])("refuses a request with %s", async (_, body) => {
    expect(await issue(issuingOf(), body, MID_NOVEMBER)).toEqual({ status: 400, body: { error: { type: "malformed" } } })
  })

  test("says when it has no key to sign with", async () => {
    const issuing: Issuing = { sql: memorySql(prepare), privateKey: async () => undefined }
    expect((await issue(issuing, { code: "0".repeat(26), tickets: [{ info: infoText(SYNC), blinded: "AAAA" }] }, MID_NOVEMBER)).status).toBe(503)
  })

  test("refuses a plan stated wrongly", async () => {
    expect((await makePlan(issuingOf(), { items: [{ product: "sync", cap: 9, perMonth: 1 }], starts: "2026-11", months: 1 })).status).toBe(400)
  })
})

describe("the operator", () => {
  const token = "t".repeat(40)

  test("is let in by their token alone", async () => {
    expect(await isOperator(`Bearer ${token}`, token)).toBe(true)
    expect(await isOperator(`Bearer ${token}x`, token)).toBe(false)
    expect(await isOperator(token, token)).toBe(false)
    expect(await isOperator(null, token)).toBe(false)
  })

  test("is let in by nobody's token when none is set, or one too short", async () => {
    expect(await isOperator("Bearer ", undefined)).toBe(false)
    expect(await isOperator("Bearer short", "short")).toBe(false)
  })
})
