import { describe, expect, it } from "vitest"

import { estimateTokens } from "./condense.js"

describe("context token estimation", () => {
  it("does not treat CJK and emoji as cheap ASCII characters", () => {
    expect(estimateTokens("你".repeat(100))).toBeGreaterThanOrEqual(100)
    expect(estimateTokens("😀".repeat(100))).toBeGreaterThanOrEqual(100)
    expect(estimateTokens("a".repeat(100))).toBe(25)
  })
})
