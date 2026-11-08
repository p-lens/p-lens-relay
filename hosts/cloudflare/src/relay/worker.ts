import { frontOf, settingsErrorText, settingsOf, type Environment } from "@p-lens-relay/relay"

export { Bucket } from "./bucket"

type Bindings = Environment & { readonly BUCKETS: DurableObjectNamespace }

/** The relay on Cloudflare: each socket handed to the Durable Object its host and label name, so that a host's can be moved on its own. */
export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const settings = settingsOf(env)
    if (!settings.ok) return new Response(settingsErrorText(settings.error), { status: 500 })
    const front = frontOf(request, settings.value)
    if (front.type === "answer") return front.response
    return env.BUCKETS.get(env.BUCKETS.idFromName(`${front.host}/${front.label}`)).fetch(request)
  },
} satisfies ExportedHandler<Bindings>
