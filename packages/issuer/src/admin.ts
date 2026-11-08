const digest = async (text: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (byte) => byte.toString(16).padStart(2, "0")).join("")

/**
 * Whether a request carries the operator's token. Compared as digests, so
 * that how long the comparison takes says nothing of the token; no token set
 * lets nobody in.
 */
export const isOperator = async (authorization: string | null, token: string | undefined): Promise<boolean> => {
  if (token === undefined || token.length < 32 || authorization === null || !authorization.startsWith("Bearer ")) return false
  return (await digest(authorization.slice("Bearer ".length))) === (await digest(token))
}
