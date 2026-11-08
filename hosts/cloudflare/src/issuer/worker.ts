import type { IssuerEnvironment } from "@p-lens-relay/issuer"

export { Desk } from "./desk"

type Bindings = IssuerEnvironment & { readonly DESK: DurableObjectNamespace }

/** The issuer on Cloudflare: every request goes to the one desk. */
export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    return env.DESK.get(env.DESK.idFromName("desk")).fetch(request)
  },
} satisfies ExportedHandler<Bindings>
