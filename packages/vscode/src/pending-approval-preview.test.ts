import { describe, expect, it } from "vitest"

import {
  pendingWriteApprovalPreviewFromEvent,
} from "./pending-approval-preview.js"

describe("pendingWriteApprovalPreviewFromEvent", () => {
  it("preserves the structured file identity and proposed content", () => {
    expect(
      pendingWriteApprovalPreviewFromEvent({
        type: "tool_approval_needed",
        partId: "part-write",
        action: {
          type: "write",
          tool: "Edit",
          description: "Edit ignored-description.ts",
          path: "src/actual.ts",
          content: "export const value = 2\n",
        },
      }),
    ).toEqual({
      partId: "part-write",
      path: "src/actual.ts",
      content: "export const value = 2\n",
    })
  })

  it("keeps compatibility with approvals from an older server", () => {
    expect(
      pendingWriteApprovalPreviewFromEvent({
        type: "tool_approval_needed",
        partId: "part-legacy",
        action: {
          type: "write",
          tool: "Write",
          description: "[Permission Rule] Write to src/legacy.ts",
          content: "legacy\n",
        },
      }),
    ).toEqual({
      partId: "part-legacy",
      path: "src/legacy.ts",
      content: "legacy\n",
    })
  })

  it("does not manufacture previews for commands or missing content", () => {
    expect(
      pendingWriteApprovalPreviewFromEvent({
        type: "tool_approval_needed",
        partId: "part-command",
        action: {
          type: "execute",
          tool: "Bash",
          description: "Run tests",
          content: "pnpm test",
        },
      }),
    ).toBeNull()
    expect(
      pendingWriteApprovalPreviewFromEvent({
        type: "tool_approval_needed",
        partId: "part-no-content",
        action: {
          type: "write",
          tool: "Edit",
          description: "Edit src/missing.ts",
          path: "src/missing.ts",
        },
      }),
    ).toBeNull()
  })
})
