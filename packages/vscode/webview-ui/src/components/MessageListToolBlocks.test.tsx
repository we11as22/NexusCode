import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ApprovalInline, BashCommandBlock } from "./MessageList.js"

describe("BashCommandBlock", () => {
  it("uses content-sized copy controls that cannot overlap in a narrow sidebar", () => {
    const html = renderToStaticMarkup(
      <BashCommandBlock
        part={{
          type: "tool",
          id: "bash-1",
          tool: "Bash",
          status: "completed",
          input: { command: "pwd" },
          output: "[exit: 0]\n/Users/mac/Projects/nexus/test",
          timeStart: 1,
          timeEnd: 1001,
        }}
      />,
    )

    expect(html).toContain("Copy command")
    expect(html).toContain("Copy output")
    expect(html.match(/nexus-bash-copy-btn/g)).toHaveLength(2)
    expect(html).not.toContain("nexus-input-context-file-btn")
  })
})

describe("ApprovalInline", () => {
  it("offers only action-scoped session authority instead of a blanket session bypass", () => {
    const html = renderToStaticMarkup(
      <ApprovalInline
        action={{
          type: "execute",
          tool: "Bash",
          description: "Run pwd",
          content: "pwd",
        }}
        onResolve={() => undefined}
      />,
    )

    expect(html).toContain("✓ Allow once")
    expect(html).toContain("∞ Session")
    expect(html).toContain("Allow this exact command for this session")
    expect(html).toContain("✗ Deny")
    expect(html).not.toContain("Allow all")
  })
})
