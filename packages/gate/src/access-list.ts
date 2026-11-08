import type { Product } from "./kinds"

/** The products an access list is kept for. */
export type ListedProduct = Extract<Product, "sharing" | "sending">

export type Member =
  | { readonly role: "editor"; readonly pubkey: string; readonly mailbox: string }
  | { readonly role: "viewer"; readonly mailbox: string }
  | { readonly role: "sender"; readonly pubkey: string; readonly mailbox: string }

/** Who may write to a book or an inbox, in plain text: pubkeys, roles and mailboxes, nothing else (PROTOCOL.md §4.3). */
export type AccessList = { readonly product: ListedProduct; readonly members: readonly Member[]; readonly stamp: number }

const HEX64 = /^[0-9a-f]{64}$/

const OPAQUE = /^[0-9a-f]{32}$/

type Fields = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is Fields => typeof value === "object" && value !== null && !Array.isArray(value)

const hasExactly = (fields: Fields, names: readonly string[]): boolean =>
  Object.keys(fields).length === names.length && names.every((name) => Object.hasOwn(fields, name))

const rolesOf: Readonly<Record<ListedProduct, readonly Member["role"][]>> = { sharing: ["editor", "viewer"], sending: ["sender"] }

const memberOf = (product: ListedProduct, value: unknown): Member | undefined => {
  if (!isRecord(value) || typeof value.mailbox !== "string" || !OPAQUE.test(value.mailbox)) return undefined
  if (!rolesOf[product].includes(value.role as Member["role"])) return undefined
  if (value.role === "viewer") return hasExactly(value, ["role", "mailbox"]) ? { role: "viewer", mailbox: value.mailbox } : undefined
  if (!hasExactly(value, ["role", "pubkey", "mailbox"]) || typeof value.pubkey !== "string" || !HEX64.test(value.pubkey)) return undefined
  return value.role === "editor"
    ? { role: "editor", pubkey: value.pubkey, mailbox: value.mailbox }
    : { role: "sender", pubkey: value.pubkey, mailbox: value.mailbox }
}

const isProduct = (value: unknown): value is ListedProduct => value === "sharing" || value === "sending"

const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length

const pubkeysOf = (members: readonly Member[]): readonly string[] => members.flatMap((member) => (member.role === "viewer" ? [] : [member.pubkey]))

const parsed = (content: string): unknown => {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

/**
 * An access list read from its content, held to exactly its fields so that
 * nothing more (a name, a note) can be put where the operator reads it; each
 * pubkey and mailbox once.
 */
export const accessListOf = (content: string): AccessList | undefined => {
  const value = parsed(content)
  if (!isRecord(value) || !hasExactly(value, ["product", "members", "stamp"]) || !isProduct(value.product)) return undefined
  if (!Number.isSafeInteger(value.stamp) || (value.stamp as number) < 0 || !Array.isArray(value.members)) return undefined
  const product = value.product
  const members = value.members.map((member) => memberOf(product, member))
  if (!members.every((member): member is Member => member !== undefined)) return undefined
  if (!distinct(members.map((member) => member.mailbox)) || !distinct(pubkeysOf(members))) return undefined
  return { product, members, stamp: value.stamp as number }
}
