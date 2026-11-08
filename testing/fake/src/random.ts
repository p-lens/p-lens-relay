/** A seeded draw, so a quirky run happens the same way every time. */
export type Draws = { readonly seed: number }

/** mulberry32: the next value in [0, 1) and the draws after it. */
export const draw = (draws: Draws): readonly [number, Draws] => {
  const seed = (draws.seed + 0x6d2b79f5) >>> 0
  const mixed = Math.imul(seed ^ (seed >>> 15), seed | 1)
  const stirred = (mixed ^ (mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61))) >>> 0
  return [((stirred ^ (stirred >>> 14)) >>> 0) / 4_294_967_296, { seed }]
}

/** As many values as asked for. */
export const drawMany = (draws: Draws, count: number): readonly [readonly number[], Draws] =>
  Array.from({ length: count }).reduce<readonly [readonly number[], Draws]>(
    ([values, sofar]) => {
      const [value, next] = draw(sofar)
      return [[...values, value], next]
    },
    [[], draws],
  )
