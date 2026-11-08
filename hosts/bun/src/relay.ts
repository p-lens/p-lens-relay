import { settingsErrorText, settingsOf } from "@p-lens-relay/relay"
import { environmentOf } from "./environment"
import { serveRelay } from "./relay-server"

const environment = environmentOf(process.env)
const settings = settingsOf(environment)
if (!settings.ok) {
  console.error(settingsErrorText(settings.error))
  process.exit(1)
}

const relay = serveRelay({
  port: Number(environment.PORT ?? 7780),
  hostname: environment.BIND_ADDRESS ?? "0.0.0.0",
  dataDirectory: environment.DATA_DIR ?? "data",
  settings: settings.value,
  warn: (text) => console.error(text),
})

console.log(`P-Lens relay (${settings.value.gate.mode}) listening on port ${relay.port}`)

const stop = (): void => void relay.stop().then(() => process.exit(0))
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
