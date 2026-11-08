import { disconnect, readClientMessage, type ConnectionId, type Outgoing } from "@p-lens-relay/core"
import { CAPS, emptyLedger, judge, memoryView, reasonOf, type GateConfig } from "@p-lens-relay/gate"
import type { ServerWebSocket } from "bun"
import { emptyFake, fakeStep, type FakeState } from "./fake"
import { PRESETS, type PresetName, type Quirks } from "./quirks"

/**
 * The fake relay over a real WebSocket, for running the conformance tests and
 * a client against: `FAKE_PRESET` names how it misbehaves (plain when unset),
 * `FAKE_QUIRKS` changes any quirk of it as JSON, `FAKE_GATE` puts a P-Lens
 * relay's gate before it (`open` or `capped`; none when unset), `PORT` is
 * where (7790).
 */
const isPreset = (name: string): name is PresetName => Object.hasOwn(PRESETS, name)

const presetName = process.env.FAKE_PRESET ?? "plain"
if (!isPreset(presetName)) throw new Error(`no preset ${presetName}: ${Object.keys(PRESETS).join(", ")}`)
const quirks: Quirks = { ...PRESETS[presetName], ...(JSON.parse(process.env.FAKE_QUIRKS ?? "{}") as Partial<Quirks>) }
const port = Number(process.env.PORT ?? 7790)
const gateMode = process.env.FAKE_GATE
if (gateMode !== undefined && gateMode !== "open" && gateMode !== "capped") throw new Error(`FAKE_GATE is open or capped, not ${gateMode}`)
const gate: GateConfig | undefined = gateMode === undefined ? undefined : { mode: gateMode, caps: CAPS }

const held: { state: FakeState; sockets: Map<ConnectionId, ServerWebSocket<{ id: ConnectionId }>>; next: number } = {
  state: emptyFake(quirks),
  sockets: new Map(),
  next: 0,
}

const information = {
  name: `p-lens fake relay (${presetName}${gateMode === undefined ? "" : `, gate ${gateMode}`})`,
  supported_nips: [1, 9, 11, 40],
  software: "p-lens-relay/fake",
  limitation: { max_message_length: quirks.rules.maxEventBytes, max_limit: quirks.rules.maxLimit, auth_required: false, payment_required: false },
}

/** The gate's refusal of an event, when a gate is put before the fake and refuses it. */
const refusalOf = (from: ConnectionId, raw: string, now: number): Outgoing | undefined => {
  const message = readClientMessage(raw)
  if (gate === undefined || message.type !== "event") return undefined
  const verdict = judge(gate, memoryView(held.state.relay.store, emptyLedger, now), message.event, undefined, now)
  return verdict.type === "refuse" ? { to: from, message: ["OK", message.event.id, false, reasonOf(verdict.refusal)] } : undefined
}

Bun.serve<{ id: ConnectionId }>({
  port,
  hostname: "127.0.0.1",
  fetch(request, server) {
    if (server.upgrade(request, { data: { id: `c${held.next++}` } })) return undefined
    return Response.json(information, { headers: { "content-type": "application/nostr+json", "access-control-allow-origin": "*" } })
  },
  websocket: {
    open(socket) {
      held.sockets.set(socket.data.id, socket)
    },
    message(socket, raw) {
      const now = Math.floor(Date.now() / 1000)
      const refused = refusalOf(socket.data.id, String(raw), now)
      const next = refused === undefined ? fakeStep(quirks, held.state, socket.data.id, String(raw), now) : { state: held.state, outgoing: [refused] }
      held.state = next.state
      next.outgoing.forEach((out) => held.sockets.get(out.to)?.send(JSON.stringify(out.message)))
    },
    close(socket) {
      held.sockets.delete(socket.data.id)
      held.state = { ...held.state, relay: disconnect(held.state.relay, socket.data.id) }
    },
  },
})

console.log(`fake relay (${presetName}) on ws://127.0.0.1:${port}`)
