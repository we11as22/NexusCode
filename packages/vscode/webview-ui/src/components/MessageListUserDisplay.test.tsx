import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { MessageList } from "./MessageList.js"

describe("MessageList user display projection", () => {
  it("renders a user_message override without exposing the internal agent prompt", () => {
    const html = renderToStaticMarkup(
      <MessageList
        messages={[
          {
            id: "user-plan-revision",
            ts: 1,
            role: "user",
            content: [
              {
                type: "text",
                text: "Revise the current implementation plan.\n\nCurrent plan:\n(private injected plan)",
                user_message: "Revise plan → Replace the license step with Markdown link checks.",
              },
            ],
          },
        ]}
      />,
    )

    expect(html).toContain(
      "Revise plan → Replace the license step with Markdown link checks.",
    )
    expect(html).not.toContain("private injected plan")
  })
})
