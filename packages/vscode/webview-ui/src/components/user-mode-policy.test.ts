import { describe, expect, it } from "vitest"
import { USER_SELECTABLE_MODES } from "./user-mode-policy.js"

describe("user-selectable modes", () => {
  it("keeps review command-scoped instead of exposing it as a chat mode", () => {
    expect(USER_SELECTABLE_MODES).toEqual(["agent", "plan", "ask", "debug"])
    expect(USER_SELECTABLE_MODES).not.toContain("review")
  })
})
