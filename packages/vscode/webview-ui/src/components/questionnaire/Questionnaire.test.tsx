import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Questionnaire } from "./Questionnaire"
import type { QuestionnaireRequest } from "./model"

const request: QuestionnaireRequest = {
  requestId: "single",
  questions: [
    {
      id: "target",
      question: "Where should I create it?",
      allowCustom: true,
      options: [
        { id: "workspace", label: "Workspace" },
        { id: "package", label: "Package" },
      ],
    },
  ],
}

describe("Questionnaire", () => {
  it("renders one question without an empty option or synthetic pager", () => {
    const html = renderToStaticMarkup(
      <Questionnaire
        request={request}
        onDismiss={() => undefined}
        onSubmit={() => undefined}
      />,
    )
    expect(html).toContain("Workspace")
    expect(html).toContain("Other")
    expect(html).not.toContain("1 of 1")
    expect(html).not.toContain("nexus-questionnaire-card")
    expect(
      html.match(/class="nexus-questionnaire-option(?:\s|")/g),
    ).toHaveLength(3)
  })

  it("omits custom input when the request disallows it", () => {
    const noCustom: QuestionnaireRequest = {
      ...request,
      requestId: "no-custom",
      questions: [{ ...request.questions[0]!, allowCustom: false }],
    }
    const html = renderToStaticMarkup(
      <Questionnaire
        request={noCustom}
        onDismiss={() => undefined}
        onSubmit={() => undefined}
      />,
    )
    expect(html).not.toContain(">Other<")
    expect(
      html.match(/class="nexus-questionnaire-option(?:\s|")/g),
    ).toHaveLength(2)
  })

  it("shows a pager only when there are multiple questions", () => {
    const multiple: QuestionnaireRequest = {
      ...request,
      requestId: "multiple",
      questions: [
        request.questions[0]!,
        {
          id: "depth",
          question: "How deep?",
          options: [
            { id: "focused", label: "Focused" },
            { id: "complete", label: "Complete" },
          ],
        },
      ],
    }
    const html = renderToStaticMarkup(
      <Questionnaire
        request={multiple}
        onDismiss={() => undefined}
        onSubmit={() => undefined}
      />,
    )
    expect(html).toContain("1 of 2")
  })
})
