import { describe, expect, it } from "vitest"

import { getContextWindowLimit } from "./context-usage.js"

describe("context window resolution", () => {
  it("uses an explicit provider/catalog capability before model heuristics", () => {
    expect(getContextWindowLimit("minimax/minimax-m2.5", 204_800)).toBe(
      204_800,
    )
  })

  it("recognizes the Kilo MiniMax M2.5 window for existing manual configs", () => {
    expect(
      getContextWindowLimit("minimax/minimax-m2.5:free"),
    ).toBe(196_608)
  })

  it("keeps an unknown OpenAI-compatible route conservative", () => {
    expect(getContextWindowLimit("vendor/unknown-model")).toBe(128_000)
  })
})
