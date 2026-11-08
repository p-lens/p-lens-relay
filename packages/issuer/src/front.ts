import type { Sql } from "@p-lens-relay/sql"
import { importPrivateKey, type PrivateNumbers } from "@p-lens-relay/tickets"
import { isOperator } from "./admin"
import { issue, makePlan, type Answer, type Issuing } from "./issuing"
import { prepare } from "./storage"

/** What the issuer is set by: its private key, and the operator's token. */
export type IssuerEnvironment = { readonly ISSUER_PRIVATE_KEY?: string | undefined; readonly ADMIN_TOKEN?: string | undefined }

/** Asking for tickets comes from the app, wherever it is served; nothing is sent with credentials. */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" }

const reply = (answer: Answer, headers: Readonly<Record<string, string>> = {}): Response =>
  Response.json(answer.body, { status: answer.status, headers })

const bodyOf = (request: Request): Promise<unknown> => request.json().catch(() => undefined)

/** The issuer over its SQLite, its tables made, its private key read the first time a ticket is asked for. */
export const issuingOf = (sql: Sql, privateKeyText: string | undefined): Issuing => {
  const held: { key: Promise<PrivateNumbers | undefined> | undefined } = { key: undefined }
  prepare(sql)
  return {
    sql,
    privateKey: () => {
      if (held.key === undefined) held.key = privateKeyText === undefined ? Promise.resolve(undefined) : importPrivateKey(privateKeyText)
      return held.key
    },
  }
}

const plansAnswer = async (issuing: Issuing, adminToken: string | undefined, request: Request): Promise<Answer> =>
  (await isOperator(request.headers.get("authorization"), adminToken))
    ? makePlan(issuing, await bodyOf(request))
    : { status: 401, body: { error: { type: "not-operator" } } }

/**
 * The issuer's front, wherever it runs: `POST /tickets` signs blinded
 * tickets on a plan code, from any page; `POST /plans` (the operator's, by
 * `ADMIN_TOKEN`) makes a plan, which a payment's adapter will do in its place.
 */
export const respond = async (issuing: Issuing, adminToken: string | undefined, request: Request, now: number): Promise<Response> => {
  const path = new URL(request.url).pathname
  if (path === "/tickets" && request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
  if (path === "/tickets" && request.method === "POST") return reply(await issue(issuing, await bodyOf(request), now), CORS)
  if (path === "/plans" && request.method === "POST") return reply(await plansAnswer(issuing, adminToken, request))
  if (path === "/tickets" || path === "/plans") return reply({ status: 404, body: { error: { type: "not-found" } } })
  return new Response("A P-Lens ticket issuer.\n", { headers: { "content-type": "text/plain; charset=utf-8" } })
}
