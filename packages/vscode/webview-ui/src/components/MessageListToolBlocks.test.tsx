import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { BashCommandBlock } from "./MessageList.js"

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
