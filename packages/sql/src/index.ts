/** What SQLite takes and gives; `null` is SQL's, and goes no further than this port. */
export type SqlValue = string | number | null

export type Row = Readonly<Record<string, SqlValue>>

/**
 * The SQLite a Durable Object keeps its data in: its own storage in the
 * relay and the issuer, `bun:sqlite` in the tests. Synchronous, as both are.
 */
export type Sql = {
  readonly run: (query: string, ...params: readonly SqlValue[]) => readonly Row[]
  readonly atomically: <T>(work: () => T) => T
}

/** A list bound as one parameter, read back by `json_each`, so that no query outgrows SQLite's bound parameters. */
export const listParam = (values: readonly (string | number)[]): string => JSON.stringify(values)

export const textOf = (row: Row | undefined, column: string): string | undefined => {
  const value = row?.[column]
  return typeof value === "string" ? value : undefined
}

export const numberOf = (row: Row | undefined, column: string): number | undefined => {
  const value = row?.[column]
  return typeof value === "number" ? value : undefined
}
