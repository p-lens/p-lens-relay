import { DurableObject } from "cloudflare:workers"
import { issuingOf, respond, type IssuerEnvironment, type Issuing } from "@p-lens-relay/issuer"
import type { Row, Sql, SqlValue } from "@p-lens-relay/sql"

/** A Durable Object's SQLite as the port: rows hold text and numbers alone. */
const sqlOf = (storage: DurableObjectStorage): Sql => ({
  run: (query, ...params) => storage.sql.exec(query, ...(params as SqlValue[])).toArray() as readonly Row[],
  atomically: (work) => storage.transactionSync(work),
})

const seconds = (): number => Math.floor(Date.now() / 1000)

/** The issuer's one Durable Object, keeping the plans; a thin shell over the issuer's front, which decides everything. */
export class Desk extends DurableObject<IssuerEnvironment> {
  private readonly issuing: Issuing

  constructor(ctx: DurableObjectState, env: IssuerEnvironment) {
    super(ctx, env)
    this.issuing = issuingOf(sqlOf(ctx.storage), env.ISSUER_PRIVATE_KEY)
  }

  override async fetch(request: Request): Promise<Response> {
    return respond(this.issuing, this.env.ADMIN_TOKEN, request, seconds())
  }
}
