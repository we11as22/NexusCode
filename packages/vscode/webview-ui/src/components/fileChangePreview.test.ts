import { describe, expect, it } from "vitest"

import type { ToolPart } from "../stores/chat.js"
import { buildFileChangePreview } from "./fileChangePreview.js"

function part(overrides: Partial<ToolPart>): ToolPart {
  return {
    type: "tool",
    id: "part-1",
    tool: "Edit",
    status: "completed",
    path: "fixture.txt",
    ...overrides,
  }
}

describe("buildFileChangePreview", () => {
  it("shows every exact added line for a newly written file", () => {
    const preview = buildFileChangePreview(
      part({
        tool: "Write",
        diffStats: { added: 2, removed: 0 },
        diffHunks: [
          { type: "add", lineNum: 1, line: "ALPHA" },
          { type: "add", lineNum: 2, line: "BETA" },
        ],
      }),
      6,
    )

    expect(preview).toEqual({
      lines: [
        { type: "add", lineNum: 1, line: "ALPHA" },
        { type: "add", lineNum: 2, line: "BETA" },
      ],
      hiddenLineCount: 0,
      statusOnly: false,
      stats: { added: 2, removed: 0 },
    })
  })

  it("shows the exact removed line before the added line for an edit", () => {
    const preview = buildFileChangePreview(
      part({
        output:
          "Successfully updated fixture.txt\n\n" +
          "<updated_content>\nALPHA\nGAMMA\n</updated_content>",
        diffStats: { added: 1, removed: 1 },
        diffHunks: [
          { type: "remove", lineNum: 2, line: "BETA" },
          { type: "add", lineNum: 2, line: "GAMMA" },
        ],
        appliedReplacements: [
          { oldSnippet: "BETA", newSnippet: "GAMMA" },
        ],
      }),
      6,
    )

    expect(preview.lines).toEqual([
      { type: "remove", lineNum: 2, line: "BETA" },
      { type: "add", lineNum: 2, line: "GAMMA" },
    ])
    expect(preview.stats).toEqual({ added: 1, removed: 1 })
  })

  it("never turns legacy updated_content into fake additions", () => {
    const preview = buildFileChangePreview(
      part({
        output:
          "Successfully updated fixture.txt\n\n" +
          "<updated_content>\nALPHA\nGAMMA\n</updated_content>",
        diffStats: { added: 1, removed: 1 },
      }),
      6,
    )

    expect(preview).toEqual({
      lines: [],
      hiddenLineCount: 2,
      statusOnly: true,
      stats: { added: 1, removed: 1 },
    })
  })

  it("uses replacement snippets only when exact hunks are unavailable", () => {
    const preview = buildFileChangePreview(
      part({
        diffStats: { added: 1, removed: 1 },
        appliedReplacements: [
          { oldSnippet: "BETA", newSnippet: "GAMMA" },
        ],
      }),
      6,
    )

    expect(preview.lines).toEqual([
      { type: "remove", lineNum: 1, line: "BETA" },
      { type: "add", lineNum: 1, line: "GAMMA" },
    ])
    expect(preview.statusOnly).toBe(false)
  })

  it("rejects malformed hunks and reports the full hidden count", () => {
    const preview = buildFileChangePreview(
      part({
        diffStats: { added: 7, removed: 3 },
        diffHunks: [
          { type: "remove", lineNum: 1, line: "old-1" },
          { type: "remove", lineNum: 2, line: "old-2" },
          { type: "add", lineNum: 1, line: "new-1" },
          { type: "context", lineNum: 2, line: "not a change" },
          { type: "add", lineNum: -1, line: "invalid" },
          { type: "add", lineNum: 2, line: "new-2" },
          { type: "add", lineNum: 3, line: "new-3" },
          { type: "add", lineNum: 4, line: "new-4" },
          { type: "add", lineNum: 5, line: "new-5" },
        ] as ToolPart["diffHunks"],
      }),
      6,
    )

    expect(preview.lines).toHaveLength(6)
    expect(preview.lines).not.toContainEqual(
      expect.objectContaining({ line: "not a change" }),
    )
    expect(preview.lines).not.toContainEqual(
      expect.objectContaining({ line: "invalid" }),
    )
    expect(preview.hiddenLineCount).toBe(4)
  })
})
