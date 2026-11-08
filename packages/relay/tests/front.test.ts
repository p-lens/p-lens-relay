import { describe, expect, test } from "bun:test"
import { frontOf } from "../src/front"
import { informationOf } from "../src/information"
import { routeOf } from "../src/routing"
import { settingsOf } from "../src/settings"

describe("routing", () => {
  test.each([
    ["wss://relay.example.com/", "relay.example.com", "00"],
    ["wss://relay.example.com", "relay.example.com", "00"],
    ["wss://relay.example.com/3f", "relay.example.com", "3f"],
    ["wss://Books.Example.com/ff", "books.example.com", "ff"],
  ])("sends %s to the bucket of %s labelled %s", (address, host, label) => {
    expect(routeOf(new URL(address))).toEqual({ type: "bucket", host, label })
  })

  test.each(["/3F", "/100", "/3f/", "/abc", "/x"])("finds nothing at %s", (path) => {
    expect(routeOf(new URL(`wss://relay.example.com${path}`))).toEqual({ type: "not-found" })
  })
})

describe("settings", () => {
  test("are open unless said otherwise", () => {
    const read = settingsOf({})
    expect(read.ok && read.value.gate.mode).toBe("open")
  })

  test("take capped, and gated with its issuer, and nothing else", () => {
    const capped = settingsOf({ ENTITLEMENT: "capped" })
    expect(capped.ok && capped.value.gate.mode).toBe("capped")
    const gated = settingsOf({ ENTITLEMENT: "gated", ISSUER_URL: "https://issuer.example.com", ISSUER_PUBLIC_KEY: "AAAA" })
    expect(gated.ok && gated.value.issuer).toEqual({ url: "https://issuer.example.com", key: "AAAA" })
    expect(settingsOf({ ENTITLEMENT: "free" })).toEqual({ ok: false, error: { type: "unknown-entitlement", given: "free" } })
  })

  test.each([
    [{ ISSUER_PUBLIC_KEY: "AAAA" }, { type: "issuer-missing", missing: "ISSUER_URL" }],
    [{ ISSUER_URL: "https://issuer.example.com" }, { type: "issuer-missing", missing: "ISSUER_PUBLIC_KEY" }],
    [{ ISSUER_URL: "http://issuer.example.com", ISSUER_PUBLIC_KEY: "AAAA" }, { type: "issuer-url-not-https", given: "http://issuer.example.com" }],
  ])("refuse gated without its issuer: %p", (issuer, error) => {
    expect(settingsOf({ ENTITLEMENT: "gated", ...issuer })).toEqual({ ok: false, error } as never)
  })
})

describe("NIP-11", () => {
  test("says what a P-Lens client may count on", () => {
    const read = settingsOf({ ENTITLEMENT: "capped", RELAY_NAME: "Test relay" })
    if (!read.ok) throw new Error("the capped settings are read")
    const information = informationOf(read.value)
    expect(information.name).toBe("Test relay")
    expect(information.limitation.max_message_length).toBeGreaterThanOrEqual(48_000)
    expect(information.limitation.auth_required).toBe(false)
    expect(information.limitation.restricted_writes).toBe(true)
    expect(information.pln).toEqual({ version: 1, labels: 256, entitlement: "capped" })
  })

  test("names a gated relay's issuer and its key", () => {
    const read = settingsOf({ ENTITLEMENT: "gated", ISSUER_URL: "https://issuer.example.com", ISSUER_PUBLIC_KEY: "AAAA" })
    if (!read.ok) throw new Error("the gated settings are read")
    expect(informationOf(read.value).pln).toEqual({
      version: 1,
      labels: 256,
      entitlement: "gated",
      issuer: { url: "https://issuer.example.com", key: "AAAA" },
    })
    expect(informationOf(read.value).limitation.payment_required).toBe(true)
  })
})

describe("the front", () => {
  const settings = (() => {
    const read = settingsOf({ ENTITLEMENT: "capped" })
    if (!read.ok) throw new Error("the capped settings are read")
    return read.value
  })()

  test("hands a socket to the bucket its address names", () => {
    const request = new Request("https://relay.example.com/3f", { headers: { upgrade: "websocket" } })
    expect(frontOf(request, settings)).toEqual({ type: "socket", host: "relay.example.com", label: "3f" })
  })

  test("answers NIP-11 to whoever asks for it, from any page", async () => {
    const front = frontOf(new Request("https://relay.example.com/", { headers: { accept: "application/nostr+json" } }), settings)
    if (front.type !== "answer") throw new Error("NIP-11 is an answer")
    expect(front.response.headers.get("access-control-allow-origin")).toBe("*")
    expect(((await front.response.json()) as { pln: unknown }).pln).toEqual({ version: 1, labels: 256, entitlement: "capped" })
  })

  test("finds nothing at an address no bucket has", () => {
    const front = frontOf(new Request("https://relay.example.com/zz", { headers: { upgrade: "websocket" } }), settings)
    expect(front.type === "answer" && front.response.status).toBe(404)
  })
})
