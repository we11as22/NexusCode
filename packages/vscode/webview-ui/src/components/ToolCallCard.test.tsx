import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { ToolPart } from "../stores/chat.js"
import {
  ApplyPatchFileChangesBlock,
  InlineFileEditBlock,
} from "./ToolCallCard.js"

function render(part: Partial<ToolPart>): string {
  return renderToStaticMarkup(
    <InlineFileEditBlock
      part={{
        type: "tool",
        id: "part-1",
        tool: "Edit",
        status: "completed",
        path: "nexus-ui-ux-smoke.txt",
        ...part,
      }}
    />,
  )
}

describe("InlineFileEditBlock", () => {
  it("renders a compact exact edit with removal before addition", () => {
    const html = render({
      diffStats: { added: 1, removed: 1 },
      diffHunks: [
        { type: "remove", lineNum: 2, line: "BETA" },
        { type: "add", lineNum: 2, line: "GAMMA" },
      ],
      appliedReplacements: [
        { oldSnippet: "BETA", newSnippet: "GAMMA" },
      ],
    })

    expect(html).toContain("nexus-file-edit-icon")
    expect(html).not.toContain("nexus-file-edit-badge")
    expect(html).toContain("nexus-ui-ux-smoke.txt")
    expect(html).toContain("+1")
    expect(html).toContain("-1")
    expect(html).toContain('data-change-kind="remove"')
    expect(html).toContain('data-change-kind="add"')
    expect(html.indexOf("BETA")).toBeLessThan(html.indexOf("GAMMA"))
  })

  it("does not expose legacy full updated_content as a green diff", () => {
    const html = render({
      output:
        "Successfully updated nexus-ui-ux-smoke.txt\n\n" +
        "<updated_content>\nALPHA\nGAMMA\n</updated_content>",
      diffStats: { added: 1, removed: 1 },
    })

    expect(html).not.toContain("ALPHA")
    expect(html).not.toContain("GAMMA")
    expect(html).toContain("Diff preview unavailable")
    expect(html).toContain("+1")
    expect(html).toContain("-1")
  })

  it("caps the compact preview at six lines and reports the remainder", () => {
    const html = render({
      tool: "Write",
      diffStats: { added: 8, removed: 0 },
      diffHunks: Array.from({ length: 8 }, (_, index) => ({
        type: "add",
        lineNum: index + 1,
        line: `line-${index + 1}`,
      })),
    })

    expect(html).toContain("line-1")
    expect(html).toContain("line-6")
    expect(html).not.toContain("line-7")
    expect(html).toContain("2 more changed lines")
  })
})

describe("ApplyPatchFileChangesBlock", () => {
  it("renders one exact compact preview per changed file", () => {
    const html = renderToStaticMarkup(
      <ApplyPatchFileChangesBlock
        part={{
          type: "tool",
          id: "patch-1",
          tool: "ApplyPatch",
          status: "completed",
          output: "Success. Updated the following files",
          changeFiles: [
            {
              path: "src/new.ts",
              operation: "create",
              binary: false,
              diffStats: { added: 1, removed: 0 },
              diffHunks: [
                { type: "add", lineNum: 1, line: "export const added = true" },
              ],
            },
            {
              path: "src/current.ts",
              operation: "modify",
              binary: false,
              diffStats: { added: 1, removed: 1 },
              diffHunks: [
                { type: "remove", lineNum: 1, line: "const current = 1" },
                { type: "add", lineNum: 1, line: "const current = 2" },
              ],
            },
          ],
        }}
      />,
    )

    expect(html.match(/nexus-file-edit-block/g)).toHaveLength(2)
    expect(html).toContain("new.ts")
    expect(html).toContain("current.ts")
    expect(html).toContain("export const added = true")
    expect(html).toContain("const current = 1")
    expect(html).toContain("const current = 2")
    expect(html).not.toContain("Success. Updated the following files")
  })
})
