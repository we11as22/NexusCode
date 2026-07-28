import { describe, expect, it } from "vitest"

import { approvalActionPath } from "./approval.js"

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
