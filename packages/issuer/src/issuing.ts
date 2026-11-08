import type { Sql } from "@p-lens-relay/sql"
import { fromBase64, infoOf, signBlinded, toBase64, type PrivateNumbers, type TicketInfo } from "@p-lens-relay/tickets"
import { codeHash, drawCode, normalizedCode } from "./codes"
import { issueRefusal, planOf, type IssueRefusal, type Plan } from "./plan"
import { countIssued, issuedCount, keepPlan, readPlan } from "./storage"

/** What the issuer works with: its SQLite, and its private key, read once. */
export type Issuing = { readonly sql: Sql; readonly privateKey: () => Promise<PrivateNumbers | undefined> }

/** An answer, as the issuer sends it: a status and a JSON body. */
export type Answer = { readonly status: number; readonly body: unknown }

const refused = (refusal: IssueRefusal): Answer => ({ status: refusal.type === "unknown-plan" ? 404 : 400, body: { error: refusal } })

const malformed: Answer = refused({ type: "malformed" })

type Asked = { readonly code: string; readonly tickets: readonly { readonly info: TicketInfo; readonly blinded: Uint8Array }[] }

const askedOf = (body: unknown): Asked | undefined => {
  const value = body as { code?: unknown; tickets?: unknown } | null
  if (typeof value !== "object" || value === null || typeof value.code !== "string" || !Array.isArray(value.tickets)) return undefined
  const code = normalizedCode(value.code)
  const tickets = value.tickets.map((ticket: { info?: unknown; blinded?: unknown } | null) => {
    const info = typeof ticket?.info === "string" ? infoOf(ticket.info) : undefined
    const blinded = typeof ticket?.blinded === "string" ? fromBase64(ticket.blinded) : undefined
    return info === undefined || blinded === undefined ? undefined : { info, blinded }
  })
  return code === undefined || !tickets.every((ticket) => ticket !== undefined) ? undefined : { code, tickets }
}

const signAll = async (key: PrivateNumbers, tickets: Asked["tickets"]): Promise<readonly string[] | undefined> => {
  const signed = await Promise.all(tickets.map((ticket) => signBlinded(key, ticket.blinded, ticket.info)))
  return signed.every((outcome) => outcome.ok) ? signed.map((outcome) => (outcome.ok ? toBase64(outcome.value) : "")) : undefined
}

/**
 * Issues blinded tickets on a plan code. The plan's counts are checked and
 * taken in one go before signing, so that two requests at once cannot pass a
 * month's allowance; they are given back if a signature cannot be made. The
 * issuer sees the plan and how many tickets it asks for, and never a ticket.
 */
export const issue = async (issuing: Issuing, body: unknown, now: number): Promise<Answer> => {
  const asked = askedOf(body)
  if (asked === undefined) return malformed
  const key = await issuing.privateKey()
  if (key === undefined) return { status: 503, body: { error: { type: "no-key" } } }
  const hash = await codeHash(asked.code)
  const infos = asked.tickets.map((ticket) => ticket.info)
  const refusal = issuing.sql.atomically(() => {
    const found = issueRefusal(readPlan(issuing.sql, hash), (product, cap, period) => issuedCount(issuing.sql, hash, product, cap, period), infos, now)
    if (found === undefined) countIssued(issuing.sql, hash, infos, 1)
    return found
  })
  if (refusal !== undefined) return refused(refusal)
  const signatures = await signAll(key, asked.tickets)
  if (signatures === undefined) {
    issuing.sql.atomically(() => countIssued(issuing.sql, hash, infos, -1))
    return malformed
  }
  return { status: 200, body: { signatures } }
}

/** Makes a plan and gives its code, which is kept by nobody but whoever is given it. */
export const makePlan = async (issuing: Issuing, body: unknown): Promise<Answer> => {
  const plan: Plan | undefined = planOf(body)
  if (plan === undefined) return malformed
  const code = drawCode()
  const hash = await codeHash(normalizedCode(code) ?? code)
  keepPlan(issuing.sql, hash, plan)
  return { status: 201, body: { code, plan } }
}
