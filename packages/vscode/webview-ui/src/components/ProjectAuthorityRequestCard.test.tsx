import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { ProjectAuthorityRequestCard } from "./ProjectAuthorityRequestCard.js"

describe("ProjectAuthorityRequestCard", () => {
  it("shows the request content without exposing its internal fingerprint", () => {
    const fingerprint = "a".repeat(64)
    const html = renderToStaticMarkup(
      <ProjectAuthorityRequestCard
        kind="mcp_server"
        payload={{ name: "local-tools", command: "node tools.mjs" }}
        fingerprint={fingerprint}
        onApprove={vi.fn()}
      />,
    )

    expect(html).toContain("mcp_server")
    expect(html).toContain("local-tools")
    expect(html).not.toContain(fingerprint)
    expect(html).not.toContain("sha256")
  })
})
