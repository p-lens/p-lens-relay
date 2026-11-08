/** How many buckets a relay's address may be given a label for: `00` to `ff`. */
export const LABELS = 256

export type Route =
  | { readonly type: "bucket"; readonly host: string; readonly label: string }
  | { readonly type: "not-found" }

const LABEL = /^\/([0-9a-f]{2})$/

/**
 * Which bucket a socket goes to: the one its address's label names, `00` for
 * the bare address, with the host it came to, by which a host's buckets can
 * be kept apart and moved to another deployment on their own.
 */
export const routeOf = (url: URL): Route => {
  const host = url.host.toLowerCase()
  if (url.pathname === "/" || url.pathname === "") return { type: "bucket", host, label: "00" }
  const label = LABEL.exec(url.pathname)?.[1]
  return label === undefined ? { type: "not-found" } : { type: "bucket", host, label }
}
