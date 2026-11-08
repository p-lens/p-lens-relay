/** The products a P-Lens relay carries, each paid for on its own. */
export type Product = "sync" | "sharing" | "sending" | "huddles"

/** What each PLN-1 kind is, by name; the numbers are PROTOCOL.md §4's. */
export const KIND = {
  bookChange: 4738,
  tip: 34738,
  accessList: 34742,
  mailbox: 34743,
  playCopy: 34739,
  sentPlay: 34740,
  huddleState: 34741,
  redemption: 28934,
  deletion: 5,
} as const

export type KindName = keyof typeof KIND

const NAMES = new Map<number, KindName>(Object.entries(KIND).map(([name, kind]) => [kind, name as KindName]))

export const kindName = (kind: number): KindName | undefined => NAMES.get(kind)
