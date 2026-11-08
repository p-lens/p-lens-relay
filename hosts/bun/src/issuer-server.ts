import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { issuingOf, respond } from "@p-lens-relay/issuer"
import { sqliteFile } from "./sqlite"

/** How the issuer is run: where it listens, where its plans are kept, its private key and the operator's token. */
export type IssuerOptions = {
  readonly port: number
  readonly hostname: string
  readonly dataDirectory: string
  readonly privateKey: string | undefined
  readonly adminToken: string | undefined
}

export type RunningIssuer = { readonly port: number; readonly stop: () => Promise<void> }

const seconds = (): number => Math.floor(Date.now() / 1000)

/** The ticket issuer as one Bun process, its plans in one SQLite file; everything is decided by the issuer's front, as on Cloudflare. */
export const serveIssuer = (options: IssuerOptions): RunningIssuer => {
  mkdirSync(options.dataDirectory, { recursive: true })
  const file = sqliteFile(join(options.dataDirectory, "issuer.sqlite"))
  const issuing = issuingOf(file.sql, options.privateKey)
  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    fetch: (request) => respond(issuing, options.adminToken, request, seconds()),
  })
  return {
    port: server.port ?? options.port,
    stop: async () => {
      await server.stop(true)
      file.close()
    },
  }
}
