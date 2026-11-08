import { describe, expect, test } from "bun:test"
import { codeHash, drawCode, normalizedCode } from "../src/codes"

describe("a plan code", () => {
  test("is drawn in groups of four, each different", () => {
    const code = drawCode()
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{2}$/)
    expect(drawCode()).not.toBe(code)
  })

  test("is read back however it is typed", () => {
    const code = drawCode()
    const plain = code.replaceAll("-", "")
    expect(normalizedCode(code)).toBe(plain)
    expect(normalizedCode(` ${code.toLowerCase()} `)).toBe(plain)
    expect(normalizedCode("0I1L".repeat(6) + "OO")).toBe("0111".repeat(6) + "00")
  })

  test.each(["", "ABC", "U".repeat(26), "A".repeat(27)])("refuses %p", (typed) => {
    expect(normalizedCode(typed)).toBeUndefined()
  })

  test("is kept as its hash alone", async () => {
    expect(await codeHash("A".repeat(26))).toMatch(/^[0-9a-f]{64}$/)
  })
})
