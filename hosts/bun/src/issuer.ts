import { environmentOf } from "./environment"
import { serveIssuer } from "./issuer-server"

const environment = environmentOf(process.env)

const issuer = serveIssuer({
  port: Number(environment.PORT ?? 7781),
  hostname: environment.BIND_ADDRESS ?? "0.0.0.0",
  dataDirectory: environment.DATA_DIR ?? "data",
  privateKey: environment.ISSUER_PRIVATE_KEY,
  adminToken: environment.ADMIN_TOKEN,
})

console.log(`P-Lens ticket issuer listening on port ${issuer.port}`)

const stop = (): void => void issuer.stop().then(() => process.exit(0))
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
