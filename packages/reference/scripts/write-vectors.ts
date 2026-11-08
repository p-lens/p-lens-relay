import { INPUTS, vectorsFrom } from "../src/vectors"

const path = new URL("../vectors/pln-1.json", import.meta.url)
await Bun.write(path, `${JSON.stringify({ inputs: INPUTS, ...(await vectorsFrom(INPUTS)) }, undefined, 2)}\n`)
console.log(`wrote ${path.pathname}`)
