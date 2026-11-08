import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NostrEvent } from "@p-lens-relay/core"
import { writer } from "@p-lens-relay/core/testing"
import { bookChange, opaque } from "@p-lens-relay/gate/testing"
import { settingsOf, type Settings } from "@p-lens-relay/relay"
import { afterEach, describe, expect, test } from "bun:test"
import { serveRelay, type RunningRelay } from "../src/relay-server"

const owner = writer(1)

const held: { relays: RunningRelay[]; directories: string[] } = { relays: [], directories: [] }

afterEach(async () => {
  await Promise.all(held.relays.map((relay) => relay.stop()))
  held.directories.forEach((directory) => rmSync(directory, { recursive: true, force: true }))
  held.relays = []
  held.directories = []
})

const settings = (environment: Record<string, string>): Settings => {
  const read = settingsOf(environment)
  if (!read.ok) throw new Error("the settings are read")
  return read.value
}

const freshDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "p-lens-relay-"))
  held.directories.push(directory)
  return directory
}

const started = (dataDirectory: string, entitlement = "open"): RunningRelay => {
  const relay = serveRelay({ port: 0, hostname: "127.0.0.1", dataDirectory, settings: settings({ ENTITLEMENT: entitlement }), warn: () => undefined })
  held.relays.push(relay)
  return relay
}

/** A socket on the relay, every message it is sent kept in order, and a way to wait for one. */
const socketOn = async (relay: RunningRelay, label = "") => {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/${label}`)
  const heard: unknown[][] = []
  const waiting: { check: () => void }[] = []
  socket.addEventListener("message", (message) => {
    heard.push(JSON.parse(String(message.data)) as unknown[])
    waiting.forEach((each) => each.check())
  })
  await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }))
  const next = (matches: (message: unknown[]) => boolean): Promise<unknown[]> =>
    new Promise((resolve) => {
      const each = { check: () => ((found) => found !== undefined && resolve(found))(heard.find(matches)) }
      waiting.push(each)
      each.check()
    })
  return { send: (message: unknown[]) => socket.send(JSON.stringify(message)), next, close: () => socket.close() }
}

const now = (): number => Math.floor(Date.now() / 1000)

const changeNow = (): NostrEvent => bookChange(owner, opaque(1), now())

describe("the relay as a Bun process", () => {
  test("answers NIP-11, saying it is a P-Lens relay", async () => {
    const relay = started(freshDirectory(), "capped")
    const response = await fetch(`http://127.0.0.1:${relay.port}/`, { headers: { accept: "application/nostr+json" } })
    expect(((await response.json()) as { pln: unknown }).pln).toEqual({ version: 1, labels: 256, entitlement: "capped" })
  })

  test("keeps what is PLN-1, gives it to whoever reads its line, and refuses anything else", async () => {
    const relay = started(freshDirectory())
    const reader = await socketOn(relay, "3f")
    reader.send(["REQ", "line", { "#v": [opaque(1)] }])
    await reader.next((message) => message[0] === "EOSE")
    const writing = await socketOn(relay, "3f")
    const change = changeNow()
    writing.send(["EVENT", change])
    expect(await writing.next((message) => message[0] === "OK" && message[1] === change.id)).toEqual(["OK", change.id, true, ""])
    expect(await reader.next((message) => message[0] === "EVENT")).toEqual(["EVENT", "line", change])
    const note = { ...change, kind: 1, id: "f".repeat(64) }
    writing.send(["EVENT", note])
    const refused = await writing.next((message) => message[0] === "OK" && message[1] === note.id)
    expect(refused[2]).toBe(false)
    reader.close()
    writing.close()
  })

  test("keeps each label's lines apart", async () => {
    const relay = started(freshDirectory())
    const writing = await socketOn(relay, "01")
    const change = changeNow()
    writing.send(["EVENT", change])
    await writing.next((message) => message[0] === "OK")
    const elsewhere = await socketOn(relay, "02")
    elsewhere.send(["REQ", "line", { "#v": [opaque(1)] }])
    await elsewhere.next((message) => message[0] === "EOSE")
    const here = await socketOn(relay, "01")
    here.send(["REQ", "line", { "#v": [opaque(1)] }])
    expect(await here.next((message) => message[0] === "EVENT")).toEqual(["EVENT", "line", change])
    writing.close()
    elsewhere.close()
    here.close()
  })

  test("still holds what it kept once started again on the same files", async () => {
    const directory = freshDirectory()
    const first = started(directory)
    const writing = await socketOn(first, "ab")
    const change = changeNow()
    writing.send(["EVENT", change])
    await writing.next((message) => message[0] === "OK")
    writing.close()
    await first.stop()
    held.relays = held.relays.filter((relay) => relay !== first)
    const again = started(directory)
    const reader = await socketOn(again, "ab")
    reader.send(["REQ", "line", { "#v": [opaque(1)] }])
    expect(await reader.next((message) => message[0] === "EVENT")).toEqual(["EVENT", "line", change])
    reader.close()
  })
})
