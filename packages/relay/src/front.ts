import { informationOf } from "./information"
import { routeOf } from "./routing"
import type { Settings } from "./settings"

/** What the relay's front makes of a request: a socket for the bucket its address names, or an answer. */
export type Front =
  | { readonly type: "socket"; readonly host: string; readonly label: string }
  | { readonly type: "answer"; readonly response: Response }

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "accept", "access-control-allow-methods": "GET" }

const wantsInformation = (request: Request): boolean => request.headers.get("accept")?.includes("application/nostr+json") === true

/** The relay's front, wherever it runs: NIP-11 by HTTP, and a socket handed to the bucket its address names. */
export const frontOf = (request: Request, settings: Settings): Front => {
  const route = routeOf(new URL(request.url))
  if (route.type === "not-found") return { type: "answer", response: new Response("not found", { status: 404 }) }
  if (request.method === "OPTIONS") return { type: "answer", response: new Response(null, { status: 204, headers: CORS }) }
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return { type: "socket", host: route.host, label: route.label }
  if (wantsInformation(request)) return { type: "answer", response: Response.json(informationOf(settings), { headers: { ...CORS, "content-type": "application/nostr+json" } }) }
  return { type: "answer", response: new Response("A P-Lens relay: connect by WebSocket.\n", { headers: { "content-type": "text/plain; charset=utf-8" } }) }
}
