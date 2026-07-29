import { describe, expect, it } from "vitest"
import type { UserQuestionRequest } from "@nexuscode/core"
import {
  canSubmitQuestionnaire,
  createQuestionnaireDraft,
  editQuestionnaireAnswer,
  nextQuestionnaireStep,
  openQuestionnaireReview,
  selectQuestionOption,
  setCustomQuestionAnswer,
} from "./questionnaire-model.js"

const request: UserQuestionRequest = {
  requestId: "cli",
  questions: [
    {
      id: "q1",
      question: "Choose a target",
      allowCustom: true,
      options: [
        { id: "a", label: "Workspace" },
        { id: "b", label: "Package" },
      ],
    },
    {
      id: "q2",
      question: "Choose a depth",
      options: [
        { id: "a", label: "Focused" },
        { id: "b", label: "Complete" },
      ],
    },
  ],
}

describe("terminal questionnaire model", () => {
  it("uses the same answer, review, and edit transitions", () => {
    const initial = createQuestionnaireDraft(request)
    const q1 = selectQuestionOption(request, initial, "q1", "a")
    expect(nextQuestionnaireStep(request, q1).activeIndex).toBe(1)
    const q2 = selectQuestionOption(request, q1, "q2", "b")
    const reviewed = openQuestionnaireReview(request, q2)
    expect(reviewed.phase).toBe("review")
    expect(canSubmitQuestionnaire(request, reviewed)).toBe(true)
    const edited = editQuestionnaireAnswer(request, reviewed, "q1")
    expect(edited.answers.q2?.optionId).toBe("b")
    expect(initial.answers).toEqual({})
  })

  it("does not create a custom answer where custom input is disabled", () => {
    const disabled = setCustomQuestionAnswer(
      request,
      createQuestionnaireDraft(request),
      "q2",
      "No",
    )
    expect(disabled.answers.q2).toBeUndefined()
  })
})
