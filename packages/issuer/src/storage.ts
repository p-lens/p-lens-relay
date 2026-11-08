import { numberOf, textOf, type Sql } from "@p-lens-relay/sql"
import type { TicketInfo, TicketProduct } from "@p-lens-relay/tickets"
import { planOf, type Plan } from "./plan"

/**
 * The issuer's tables: each plan under its code's hash, and how many tickets
 * of each item it has been issued in each month. Nothing about a ticket is
 * kept: not its blinded message, nor when it was asked for.
 */
const STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS plans (
    code_hash TEXT PRIMARY KEY,
    items TEXT NOT NULL,
    starts TEXT NOT NULL,
    ends TEXT NOT NULL
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS issued (
    code_hash TEXT NOT NULL,
    product TEXT NOT NULL,
    cap INTEGER NOT NULL,
    period TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (code_hash, product, cap, period)
  ) WITHOUT ROWID`,
]

export const prepare = (sql: Sql): void => {
  sql.atomically(() => STATEMENTS.forEach((statement) => sql.run(statement)))
}

export const keepPlan = (sql: Sql, codeHash: string, plan: Plan): void => {
  sql.run("INSERT INTO plans (code_hash, items, starts, ends) VALUES (?, ?, ?, ?)", codeHash, JSON.stringify(plan.items), plan.starts, plan.ends)
}

const monthsBetween = (starts: string, ends: string): number => {
  const [startYear, startMonth] = starts.split("-").map(Number) as [number, number]
  const [endYear, endMonth] = ends.split("-").map(Number) as [number, number]
  return (endYear - startYear) * 12 + (endMonth - startMonth)
}

export const readPlan = (sql: Sql, codeHash: string): Plan | undefined => {
  const row = sql.run("SELECT items, starts, ends FROM plans WHERE code_hash = ?", codeHash)[0]
  const starts = textOf(row, "starts")
  const ends = textOf(row, "ends")
  if (row === undefined || starts === undefined || ends === undefined) return undefined
  return planOf({ items: JSON.parse(textOf(row, "items") ?? "[]"), starts, months: monthsBetween(starts, ends) })
}

export const issuedCount = (sql: Sql, codeHash: string, product: TicketProduct, cap: number, period: string): number =>
  numberOf(sql.run("SELECT count FROM issued WHERE code_hash = ? AND product = ? AND cap = ? AND period = ?", codeHash, product, cap, period)[0], "count") ?? 0

/** Counts tickets as issued, or (by a negative step) gives them back when signing them failed. */
export const countIssued = (sql: Sql, codeHash: string, infos: readonly TicketInfo[], step: 1 | -1): void => {
  infos.forEach((info) =>
    sql.run(
      `INSERT INTO issued (code_hash, product, cap, period, count) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (code_hash, product, cap, period) DO UPDATE SET count = count + excluded.count`,
      codeHash,
      info.product,
      info.cap,
      info.period,
      step,
    ),
  )
}
