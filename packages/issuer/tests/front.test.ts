import { memorySql } from "@p-lens-relay/sql/testing"
import { describe, expect, test } from "bun:test"
import { issuingOf, respond } from "../src/front"

const TOKEN = "t".repeat(32)
const NOW = Date.UTC(2026, 10, 15) / 1000

const issuing = () => issuingOf(memorySql(() => undefined), undefined)

const asked = (path: string, init: RequestInit = {}): Request => new Request(`https://issuer.example.com${path}`, init)

describe("the issuer's front", () => {
  test("lets any page ask for tickets", async () => {
    const preflight = await respond(issuing(), TOKEN, asked("/tickets", { method: "OPTIONS" }), NOW)
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*")
    const unknown = await respond(issuing(), TOKEN, asked("/tickets", { method: "POST", body: JSON.stringify({ code: "0000-0000-0000-0000", tickets: [] }) }), NOW)
    expect(unknown.headers.get("access-control-allow-origin")).toBe("*")
    expect(unknown.status).toBeGreaterThanOrEqual(400)
  })

  test("makes a plan for the operator alone", async () => {
    const plan = { items: [{ product: "sync", cap: 1, perMonth: 2 }], starts: "2026-11", months: 1 }
    const stranger = await respond(issuing(), TOKEN, asked("/plans", { method: "POST", body: JSON.stringify(plan) }), NOW)
    expect(stranger.status).toBe(401)
    const operator = await respond(issuing(), TOKEN, asked("/plans", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(plan) }), NOW)
    expect(operator.status).toBe(201)
    expect(operator.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("says what it is anywhere else", async () => {
    expect(await (await respond(issuing(), TOKEN, asked("/"), NOW)).text()).toBe("A P-Lens ticket issuer.\n")
    expect((await respond(issuing(), TOKEN, asked("/plans"), NOW)).status).toBe(404)
  })
})
