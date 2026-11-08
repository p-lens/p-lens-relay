import { mkdirSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { bucketOf, frontOf, HELD_IN_PROCESS, leave, prune, PRUNING_SECONDS, receive, wake, type Bucket, type Outgoing, type Settings } from "@p-lens-relay/relay"
import type { Server, ServerWebSocket } from "bun"
import { sqliteFile, type SqliteFile } from "./sqlite"

/** What a socket carries: the label of the bucket it is on, and its id there. */
type Carried = { readonly label: string; readonly id: string }

type Socket = ServerWebSocket<Carried>

/** A bucket as this process holds it: its file, and the sockets on it by their ids. */
type Held = { readonly bucket: Bucket; readonly file: SqliteFile; readonly sockets: Map<string, Socket> }

/** How the relay is run: where it listens, where its buckets are kept, how it is set, and where a warning goes. */
export type RelayOptions = {
  readonly port: number
  readonly hostname: string
  readonly dataDirectory: string
  readonly settings: Settings
  readonly warn: (text: string) => void
}

export type RunningRelay = { readonly port: number; readonly stop: () => Promise<void> }

/** The largest message a socket may send: an event of the largest size the relay takes, with room for the frame around it. */
const MOST_MESSAGE_BYTES = 256 * 1024

const BUCKET_FILE = /^([0-9a-f]{2})\.sqlite$/

const seconds = (): number => Math.floor(Date.now() / 1000)

const newSocketId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")

const labelsKept = (directory: string): readonly string[] => readdirSync(directory).flatMap((name) => BUCKET_FILE.exec(name)?.[1] ?? [])

/**
 * The relay as one Bun process: a SQLite file for each label of its address,
 * opened when first asked for and from the start for every label already
 * kept, so that what has run out is taken out of each. One process keeps one
 * host's buckets, by their labels alone: a host of its own is a process of
 * its own. Everything is decided by the relay's sessions, as on Cloudflare.
 */
export const serveRelay = (options: RelayOptions): RunningRelay => {
  mkdirSync(options.dataDirectory, { recursive: true })
  const buckets = new Map<string, Held>()
  const heldOf = (label: string): Held => {
    const kept = buckets.get(label)
    if (kept !== undefined) return kept
    const file = sqliteFile(join(options.dataDirectory, `${label}.sqlite`))
    const held: Held = { bucket: bucketOf(file.sql, options.settings, HELD_IN_PROCESS, options.warn), file, sockets: new Map() }
    wake(held.bucket, [])
    buckets.set(label, held)
    return held
  }
  labelsKept(options.dataDirectory).forEach(heldOf)
  const send = (held: Held, outgoing: readonly Outgoing[]): void => outgoing.forEach((out) => held.sockets.get(out.to)?.send(JSON.stringify(out.message)))
  const pruning = setInterval(() => buckets.forEach((held) => prune(held.bucket.sql, seconds())), PRUNING_SECONDS * 1000)
  const server: Server<Carried> = Bun.serve<Carried>({
    port: options.port,
    hostname: options.hostname,
    fetch: (request, served) => {
      const front = frontOf(request, options.settings)
      if (front.type === "answer") return front.response
      return served.upgrade(request, { data: { label: front.label, id: newSocketId() } }) ? undefined : new Response("expected a WebSocket", { status: 426 })
    },
    websocket: {
      maxPayloadLength: MOST_MESSAGE_BYTES,
      idleTimeout: 960,
      open: (socket) => void heldOf(socket.data.label).sockets.set(socket.data.id, socket),
      message: async (socket, message) => {
        const held = heldOf(socket.data.label)
        if (typeof message !== "string") return void socket.send(JSON.stringify(["NOTICE", "invalid: binary message"]))
        send(held, await receive(held.bucket, socket.data.id, message, seconds()))
      },
      close: (socket) => {
        const held = heldOf(socket.data.label)
        held.sockets.delete(socket.data.id)
        leave(held.bucket, socket.data.id)
      },
    },
  })
  return {
    port: server.port ?? options.port,
    stop: async () => {
      clearInterval(pruning)
      await server.stop(true)
      buckets.forEach((held) => held.file.close())
      buckets.clear()
    },
  }
}
