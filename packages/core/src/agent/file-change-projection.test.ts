import { describe, expect, it } from "vitest"

import { projectFileChangeToolResult } from "./file-change-projection.js"

describe("projectFileChangeToolResult", () => {
  it("projects an exact bounded Write diff for both durable session and live UI use", () => {
    expect(
      projectFileChangeToolResult(
        "Write",
        { file_path: "nexus-ui-ux-smoke.txt" },
        {
          addedLines: 2,
          removedLines: 0,
          writtenContent: "ALPHA\nBETA\n",
          diffHunks: [
            { type: "add", lineNum: 1, line: "ALPHA" },
            { type: "add", lineNum: 2, line: "BETA" },
          ],
        },
      ),
    ).toEqual({
      path: "nexus-ui-ux-smoke.txt",
      diffStats: { added: 2, removed: 0 },
      diffHunks: [
        { type: "add", lineNum: 1, line: "ALPHA" },
        { type: "add", lineNum: 2, line: "BETA" },
      ],
    })
  })

  it("projects the exact removed and added Edit snippets", () => {
    expect(
      projectFileChangeToolResult(
        "Edit",
        { file_path: "nexus-ui-ux-smoke.txt" },
        {
          addedLines: 1,
          removedLines: 1,
          diffHunks: [
            { type: "remove", lineNum: 2, line: "BETA" },
            { type: "add", lineNum: 2, line: "GAMMA" },
          ],
          appliedReplacements: [
            { oldSnippet: "BETA", newSnippet: "GAMMA" },
          ],
        },
      ),
    ).toEqual({
      path: "nexus-ui-ux-smoke.txt",
      diffStats: { added: 1, removed: 1 },
      diffHunks: [
        { type: "remove", lineNum: 2, line: "BETA" },
        { type: "add", lineNum: 2, line: "GAMMA" },
      ],
      appliedReplacements: [
        { oldSnippet: "BETA", newSnippet: "GAMMA" },
      ],
    })
  })

  it("drops malformed and excess UI metadata without persisting full contents", () => {
    const diffHunks = Array.from({ length: 205 }, (_, index) => ({
      type: index === 1 ? "context" : index === 2 ? "other" : "add",
      lineNum: index + 1,
      line: `line-${index + 1}`,
    }))
    diffHunks.push(
      { type: "remove", lineNum: -1, line: "negative" },
      { type: "remove", lineNum: 1.5, line: "fractional" },
    )

    const projection = projectFileChangeToolResult(
      "Write",
      { path: "large.txt" },
      {
        addedLines: 205.8,
        removedLines: 0,
        writtenContent: "must not be persisted",
        diffHunks,
        appliedReplacements: [
          { oldSnippet: "ignored for Write", newSnippet: "ignored" },
        ],
      },
    )

    expect(projection.path).toBe("large.txt")
    expect(projection.diffStats).toEqual({ added: 205, removed: 0 })
    expect(projection.diffHunks).toHaveLength(200)
    expect(projection.diffHunks).not.toContainEqual(
      expect.objectContaining({ type: "context" }),
    )
    expect(projection).not.toHaveProperty("writtenContent")
    expect(projection).not.toHaveProperty("appliedReplacements")
  })

  it("returns no semantic projection for unrelated tools or invalid metadata", () => {
    expect(
      projectFileChangeToolResult(
        "Read",
        { file_path: "a.txt" },
        { addedLines: 1, removedLines: 0 },
      ),
    ).toEqual({})

    expect(
      projectFileChangeToolResult(
        "Edit",
        { file_path: "" },
        {
          addedLines: Number.NaN,
          removedLines: -1,
          diffHunks: [{ type: "add", lineNum: 1, line: 42 }],
          appliedReplacements: [{ oldSnippet: "old", newSnippet: 42 }],
        },
      ),
    ).toEqual({})
  })
})
