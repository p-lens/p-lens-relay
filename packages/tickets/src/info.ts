/** The products a ticket pays for; the same as the gate's. */
export type TicketProduct = "sync" | "sharing" | "sending" | "huddles"

/** What a ticket says openly: the product, its cap, and the month it pays for. */
export type TicketInfo = { readonly product: TicketProduct; readonly cap: number; readonly period: string }

const PRODUCTS: readonly TicketProduct[] = ["sync", "sharing", "sending", "huddles"]

const INFO = /^pln-1;product=([a-z]+);cap=([1-9][0-9]{0,5});period=(\d{4}-(?:0[1-9]|1[0-2]))$/

/** The public information a ticket is signed under (PROTOCOL.md §9.2). */
export const infoText = (info: TicketInfo): string => `pln-1;product=${info.product};cap=${info.cap};period=${info.period}`

/** The public information read back, held to exactly the form `infoText` writes. */
export const infoOf = (text: string): TicketInfo | undefined => {
  const match = INFO.exec(text)
  const product = PRODUCTS.find((candidate) => candidate === match?.[1])
  if (match === null || product === undefined) return undefined
  return { product, cap: Number(match[2]), period: match[3] as string }
}

/** The month a moment falls in, `YYYY-MM` in UTC. */
export const periodOf = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 7)

/** The month after one. */
export const nextPeriod = (period: string): string => {
  const [year, month] = period.split("-").map(Number) as [number, number]
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7)
}
