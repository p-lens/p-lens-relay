import fixture from "../tests/fixtures/test-only-key.json"
import { importPrivateKey, importPublicKey } from "./keys"
import type { PrivateNumbers, PublicNumbers } from "./pbrsa"

/** The test-only issuer key pair, for this repository's tests alone. */
export const testKeys = async (): Promise<{
  readonly publicKey: PublicNumbers
  readonly privateKey: PrivateNumbers
  readonly publicText: string
  readonly privateText: string
}> => {
  const publicKey = await importPublicKey(fixture.publicKey)
  const privateKey = await importPrivateKey(fixture.privateKey)
  if (publicKey === undefined || privateKey === undefined) throw new Error("the test key is read")
  return { publicKey, privateKey, publicText: fixture.publicKey, privateText: fixture.privateKey }
}
