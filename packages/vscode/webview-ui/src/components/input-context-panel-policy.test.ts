import { describe, expect, it } from "vitest"

import {
  appliedFileLabel,
  inputContextPanelKind,
  uniqueEditedFileCount,
} from "./input-context-panel-policy.js"

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

describe("applied edit file summary", () => {
  it("counts unique paths instead of edit operations", () => {
    const edits = [
      { path: "nexus-ui-fresh-a.txt" },
      { path: "nexus-ui-fresh-b.txt" },
      { path: "nexus-ui-fresh-a.txt" },
    ]

    expect(uniqueEditedFileCount(edits)).toBe(2)
    expect(appliedFileLabel(edits)).toBe("2 Files")
  })

  it("uses the singular label when several operations touch one file", () => {
    const edits = [
      { path: "fixture.txt" },
      { path: "fixture.txt" },
    ]

    expect(uniqueEditedFileCount(edits)).toBe(1)
    expect(appliedFileLabel(edits)).toBe("1 File")
  })
})
