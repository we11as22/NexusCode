import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import {
  CompletedWorkBlock,
  CompletedWorkDetails,
} from "./CompletedWorkBlock"

describe("chat grid contract", () => {
  it("assigns exactly one content slot to completed work details", () => {
    const html = renderToStaticMarkup(
      <CompletedWorkDetails>
        <div className="nexus-tool-call-card">tool</div>
      </CompletedWorkDetails>,
    )
    expect(html.match(/nexus-chat-slot-content/g)).toHaveLength(1)
  })

  it("keeps final output after and outside worked details", () => {
    const html = renderToStaticMarkup(
      <>
        <CompletedWorkBlock durationMs={6000}>
          <div className="nexus-tool-call-card">tool</div>
        </CompletedWorkBlock>
        <div className="nexus-final-answer nexus-chat-slot-content">done</div>
      </>,
    )
    expect(html.indexOf("nexus-worked-details")).toBeLessThan(
      html.indexOf("nexus-final-answer"),
    )
    expect(html).toContain("nexus-chat-slot-root")
  })
})
