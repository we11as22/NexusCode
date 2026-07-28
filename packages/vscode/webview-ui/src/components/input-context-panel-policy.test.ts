import { describe, expect, it } from "vitest"

import { inputContextPanelKind } from "./input-context-panel-policy.js"

describe("inputContextPanelKind", () => {
  it("keeps pending approval controls owned by the matching tool card", () => {
    expect(
      inputContextPanelKind({
        hasPendingApproval: true,
        mode: "agent",
        appliedEditCount: 0,
      }),
    ).toBe("none")
  })

  it("shows the sticky review surface only for applied code changes", () => {
    expect(
      inputContextPanelKind({
        hasPendingApproval: false,
        mode: "agent",
        appliedEditCount: 1,
      }),
    ).toBe("applied-changes")
    expect(
      inputContextPanelKind({
        hasPendingApproval: false,
        mode: "ask",
        appliedEditCount: 1,
      }),
    ).toBe("none")
  })
})
