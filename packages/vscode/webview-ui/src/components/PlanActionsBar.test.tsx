import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { PlanActionsBar } from "../App.js"

describe("PlanActionsBar", () => {
  it("renders the plan artifact with Codex-style approve, revise, and dismiss controls", () => {
    const html = renderToStaticMarkup(
      <PlanActionsBar
        planFollowupText={"# Safe plan\n\n1. Inspect\n2. Implement\n3. Verify"}
        collapsed={false}
        onChoice={vi.fn()}
        onExpand={vi.fn()}
        onMinimize={vi.fn()}
      />,
    )

    expect(html).toContain("Safe plan")
    expect(html).toContain("Implement this plan?")
    expect(html).toContain("Yes, implement this plan")
    expect(html).toContain("No, and tell Nexus what to do differently")
    expect(html).toContain("Dismiss")
    expect(html).not.toContain("3. Exit Plan")
  })
})
