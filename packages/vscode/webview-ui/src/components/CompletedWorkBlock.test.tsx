import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { CompletedWorkDetails } from "./CompletedWorkBlock.js"

describe("CompletedWorkDetails", () => {
  it("uses local compact rows instead of nesting global message spacing", () => {
    const html = renderToStaticMarkup(
      <CompletedWorkDetails>
        <div>Thought for 6s</div>
        <div>fixture.txt +1 -1</div>
      </CompletedWorkDetails>,
    )

    expect(html).toContain("nexus-worked-details")
    expect(html.match(/nexus-worked-item/g)).toHaveLength(2)
    expect(html).not.toContain("message-list-item")
  })
})
