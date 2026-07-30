import { describe, expect, it } from "vitest"

import {
  approvalActionLabel,
  approvalActionPath,
  approvalActionWarning,
} from "./approval.js"

describe("approvalActionPath", () => {
  it("prefers the structured path over display text", () => {
    expect(
      approvalActionPath({
        type: "write",
        tool: "Edit",
        description: "Edit wrong.ts",
        path: "src/right.ts",
      }),
    ).toBe("src/right.ts")
  })

  it("reads the exact legacy write description for older servers", () => {
    expect(
      approvalActionPath({
        type: "write",
        tool: "Write",
        description: "[Permission Rule] Write to src/legacy.ts",
      }),
    ).toBe("src/legacy.ts")
  })
})

describe("sandbox escalation presentation", () => {
  it("shows the exact command and one-shot boundary", () => {
    const action = {
      type: "sandbox_escalation",
      tool: "Bash",
      description: "The OS sandbox blocked this command.",
      content: "git push origin main",
    }

    expect(approvalActionLabel(action)).toBe(
      "Run once outside OS sandbox: git push origin main",
    )
    expect(approvalActionWarning(action)).toMatch(/exact command once/i)
  })

  it("prefers the authoritative host warning", () => {
    expect(
      approvalActionWarning({
        type: "sandbox_escalation",
        tool: "Bash",
        description: "blocked",
        warning: "This command can access resources outside the workspace.",
      }),
    ).toBe("This command can access resources outside the workspace.")
  })
})
