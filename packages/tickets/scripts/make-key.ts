import { keyTexts } from "../src/keys"

/**
 * Makes the issuer's key pair and prints it: the public key for the relay
 * (`ISSUER_PUBLIC_KEY`) and the private key for the issuer
 * (`wrangler secret put ISSUER_PRIVATE_KEY`), never to be committed.
 * RSAPBSSA needs safe primes, which OpenSSL draws in a second where
 * JavaScript takes minutes. `BITS` sets the modulus, 2048 unless set.
 */
const safePrime = (bits: number): bigint => {
  const drawn = Bun.spawnSync(["openssl", "prime", "-generate", "-safe", "-bits", String(bits), "-hex"])
  if (drawn.exitCode !== 0) throw new Error(`openssl could not draw a safe prime: ${drawn.stderr.toString()}`)
  return BigInt(`0x${drawn.stdout.toString().trim()}`)
}

const drawnPair = (half: number): readonly [bigint, bigint] => {
  const p = safePrime(half)
  const q = safePrime(half)
  return p === q ? drawnPair(half) : [p, q]
}

const bits = Number(process.env.BITS ?? 2048)
const [p, q] = drawnPair(bits / 2)
const keys = await keyTexts(p, q)
console.log(`ISSUER_PUBLIC_KEY=${keys.publicKey}`)
console.log(`ISSUER_PRIVATE_KEY=${keys.privateKey}`)
