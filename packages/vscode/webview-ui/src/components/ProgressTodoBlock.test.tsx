import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ProgressTodoBlock } from "./ProgressTodoBlock.js"

describe("ProgressTodoBlock lifecycle", () => {
  it("does not keep a stale completed checklist pinned after a restored session", () => {
    const html = renderToStaticMarkup(
      <ProgressTodoBlock
        todo={JSON.stringify([
          { id: "one", content: "First milestone", status: "completed" },
          { id: "two", content: "Second milestone", status: "completed" },
        ])}
        isRunning={false}
      />,
    )

    expect(html).toBe("")
  })

  it("keeps an active checklist visible", () => {
    const html = renderToStaticMarkup(
      <ProgressTodoBlock
        todo={JSON.stringify([
          { id: "one", content: "First milestone", status: "completed" },
          { id: "two", content: "Second milestone", status: "in_progress" },
        ])}
        isRunning
      />,
    )

    expect(html).toContain("To-dos 2")
    expect(html).toContain("Second milestone")
  })
})
