import { describe, expect, it } from "vitest"

import { sessionDisplayTitle } from "./session-label.js"

describe("sessionDisplayTitle", () => {
  it("uses a human title when one is available", () => {
    expect(
      sessionDisplayTitle({
        id: "session_1785274367000_a1b2c3d4",
        title: "Investigate parser",
      }),
    ).toBe("Investigate parser")
  })

  it("never exposes the opaque id when a session has no title", () => {
    expect(
      sessionDisplayTitle({
        id: "remote-session-1234567890abcdef",
        title: "  ",
      }),
    ).toBe("Untitled session")
  })
})
