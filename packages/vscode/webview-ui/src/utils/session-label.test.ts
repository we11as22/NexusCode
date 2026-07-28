import { describe, expect, it } from "vitest"

import { formatSessionLabel } from "./session-label.js"

describe("formatSessionLabel", () => {
  it("uses the unique suffix of local timestamp-based session ids", () => {
    expect(formatSessionLabel("session_1785274367000_a1b2c3d4")).toBe("a1b2c3d4")
  })

  it("keeps short opaque remote ids readable", () => {
    expect(formatSessionLabel("run-42")).toBe("run-42")
  })

  it("uses the final characters for long opaque ids", () => {
    expect(formatSessionLabel("remote-session-1234567890abcdef")).toBe("90abcdef")
  })
})
