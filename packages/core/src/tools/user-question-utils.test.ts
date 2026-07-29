import { describe, expect, it } from "vitest"

import type { UserQuestionRequest } from "../types.js"
import {
  NEXUS_CUSTOM_OPTION_ID,
  formatQuestionnaireAnswersForAgent,
  validateQuestionnaireAnswers,
} from "./user-question-utils.js"

const request: UserQuestionRequest = {
  requestId: "request-1",
  title: "Choose",
  customOptionLabel: "Other",
  questions: [
    {
      id: "target",
      question: "Where should the change go?",
      allowCustom: true,
      options: [
        { id: "workspace", label: "Workspace" },
        { id: "worktree", label: "Worktree" },
      ],
    },
  ],
}

describe("questionnaire answer validation", () => {
  it("rejects an option id that was not offered", () => {
    expect(() =>
      formatQuestionnaireAnswersForAgent(request, [
        {
          questionId: "target",
          optionId: "forged",
          optionLabel: "Forged",
        },
      ]),
    ).toThrow(/unknown option/i)
  })

  it("rejects a custom row without non-empty custom text", () => {
    expect(() =>
      formatQuestionnaireAnswersForAgent(request, [
        {
          questionId: "target",
          optionId: NEXUS_CUSTOM_OPTION_ID,
          customText: " ",
        },
      ]),
    ).toThrow(/custom answer/i)
  })

  it("rejects duplicate answers for one question", () => {
    expect(() =>
      validateQuestionnaireAnswers(request, [
        { questionId: "target", optionId: "workspace" },
        { questionId: "target", optionId: "worktree" },
      ]),
    ).toThrow(/duplicate answer/i)
  })

  it("normalizes a valid custom answer in question order", () => {
    expect(
      validateQuestionnaireAnswers(request, [
        {
          questionId: "target",
          optionId: NEXUS_CUSTOM_OPTION_ID,
          customText: "  use the existing checkout  ",
        },
      ]),
    ).toEqual([
      {
        questionId: "target",
        optionId: NEXUS_CUSTOM_OPTION_ID,
        optionLabel: "Other",
        customText: "use the existing checkout",
      },
    ])
  })
})
