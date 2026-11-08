import { DurableObject } from "cloudflare:workers"
import { bucketOf, dueOf, leave, prune, receive, settingsErrorText, settingsOf, wake, type Bucket as Held, type Carried, type Environment, type Outgoing } from "@p-lens-relay/relay"
import type { Row, Sql, SqlValue } from "@p-lens-relay/sql"

/**
 * What each socket carries through hibernation: its id, and its subscriptions
 * unless they did not fit, when the bucket keeps them in SQLite under the id.
 */
type Attachment = { readonly socket: string; readonly subscriptions?: Carried }

/** A Durable Object's SQLite as the port: rows hold text and numbers alone, as a bucket never keeps a blob. */
const sqlOf = (storage: DurableObjectStorage): Sql => ({
  run: (query, ...params) => storage.sql.exec(query, ...(params as SqlValue[])).toArray() as readonly Row[],
  atomically: (work) => storage.transactionSync(work),
})

const attachmentOf = (socket: WebSocket): Attachment | undefined => (socket.deserializeAttachment() as Attachment | null) ?? undefined

const socketIdOf = (socket: WebSocket): string | undefined => attachmentOf(socket)?.socket

/** Has a socket carry its subscriptions, false when they are larger than an attachment may be and it carries its id alone. */
const carriedBy = (socket: WebSocket, id: string, subscriptions: Carried): boolean => {
  try {
    socket.serializeAttachment({ socket: id, subscriptions } satisfies Attachment)
    return true
  } catch {
    socket.serializeAttachment({ socket: id } satisfies Attachment)
    return false
  }
}

const millisecondsOf = (at: number): number => (at + 1) * 1000

const newSocketId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")

const textOf = (message: string | ArrayBuffer): string | undefined => (typeof message === "string" ? message : undefined)

const seconds = (): number => Math.floor(Date.now() / 1000)

/**
 * A bucket of lines: the Durable Object a label of the relay's address names.
 * It holds its sockets by WebSocket hibernation, so that it sleeps between
 * messages, each socket carrying its own subscriptions, and keeps everything
 * else in its own SQLite. It wakes by an alarm only when something it keeps
 * runs out, never on a timer. It is a thin shell over the relay's sessions,
 * which decide everything.
 */
export class Bucket extends DurableObject<Environment> {
  private readonly bucket: Held
  private readonly pruning: { at: number | undefined } = { at: undefined }

  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env)
    const settings = settingsOf(env)
    if (!settings.ok) throw new Error(settingsErrorText(settings.error))
    const holding = { carry: (id: string, subscriptions: Carried) => this.carry(id, subscriptions), due: (at: number) => void this.due(at) }
    this.bucket = bucketOf(sqlOf(ctx.storage), settings.value, holding, (text) => console.error(text))
    ctx.blockConcurrencyWhile(async () => {
      wake(this.bucket, ctx.getWebSockets().flatMap((socket) => {
        const attachment = attachmentOf(socket)
        return attachment === undefined ? [] : [{ socket: attachment.socket, carried: attachment.subscriptions }]
      }))
      this.pruning.at = (await ctx.storage.getAlarm()) ?? undefined
      const due = dueOf(this.bucket.sql)
      if (due !== undefined) await this.due(due)
    })
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 })
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ socket: newSocketId() } satisfies Attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const from = socketIdOf(socket)
    const raw = textOf(message)
    if (from === undefined) return socket.close(1011, "lost its id")
    if (raw === undefined) return socket.send(JSON.stringify(["NOTICE", "invalid: binary message"]))
    this.send(await receive(this.bucket, from, raw, seconds()))
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    const id = socketIdOf(socket)
    if (id !== undefined) leave(this.bucket, id)
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    const id = socketIdOf(socket)
    if (id !== undefined) leave(this.bucket, id)
  }

  override async alarm(): Promise<void> {
    prune(this.bucket.sql, seconds())
    this.pruning.at = undefined
    const due = dueOf(this.bucket.sql)
    if (due !== undefined) await this.due(due)
  }

  private carry(id: string, subscriptions: Carried): boolean {
    const socket = this.ctx.getWebSockets().find((open) => socketIdOf(open) === id)
    return socket === undefined || carriedBy(socket, id, subscriptions)
  }

  /** Sets the alarm for when something runs out, unless it is set for sooner already. */
  private async due(at: number): Promise<void> {
    const when = Math.max(millisecondsOf(at), Date.now() + 1000)
    if (this.pruning.at !== undefined && this.pruning.at <= when) return
    this.pruning.at = when
    await this.ctx.storage.setAlarm(when)
  }

  private send(outgoing: readonly Outgoing[]): void {
    if (outgoing.length === 0) return
    const sockets = new Map(this.ctx.getWebSockets().flatMap((socket) => {
      const id = socketIdOf(socket)
      return id === undefined ? [] : [[id, socket] as const]
    }))
    outgoing.forEach((out) => sockets.get(out.to)?.send(JSON.stringify(out.message)))
  }
}
