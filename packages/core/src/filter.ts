import { tagValues, type NostrEvent } from "./event"

export type Filter = {
  readonly ids?: readonly string[]
  readonly authors?: readonly string[]
  readonly kinds?: readonly number[]
  readonly since?: number
  readonly until?: number
  readonly limit?: number
  readonly [tag: `#${string}`]: readonly string[] | undefined
}

const tagNames = (filter: Filter): readonly string[] =>
  Object.keys(filter).flatMap((key) => (key.startsWith("#") && key.length === 2 ? [key.slice(1)] : []))

const anyOf = <T>(wanted: readonly T[] | undefined, value: T): boolean => wanted === undefined || wanted.includes(value)

const tagsMatch = (filter: Filter, event: NostrEvent): boolean =>
  tagNames(filter).every((name) => {
    const wanted = filter[`#${name}`] ?? []
    return tagValues(event, name).some((value) => wanted.includes(value))
  })

export const matches = (filter: Filter, event: NostrEvent): boolean =>
  anyOf(filter.ids, event.id) &&
  anyOf(filter.authors, event.pubkey) &&
  anyOf(filter.kinds, event.kind) &&
  (filter.since === undefined || event.created_at >= filter.since) &&
  (filter.until === undefined || event.created_at <= filter.until) &&
  tagsMatch(filter, event)

export const matchesAny = (filters: readonly Filter[], event: NostrEvent): boolean => filters.some((filter) => matches(filter, event))

const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string")

const isNumberList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => Number.isSafeInteger(item))

const fieldHolds = ([key, value]: readonly [string, unknown]): boolean => {
  if (key === "ids" || key === "authors" || /^#[A-Za-z]$/.test(key)) return isStringList(value)
  if (key === "kinds") return isNumberList(value)
  if (key === "since" || key === "until" || key === "limit") return Number.isSafeInteger(value) && (value as number) >= 0
  return false
}

export const isFilter = (value: unknown): value is Filter =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.entries(value).every(fieldHolds)
