import { describe, expect, it } from "vitest"
import {
  canSubmitQuestionnaire,
  createQuestionnaireDraft,
  editQuestionnaireAnswer,
  nextQuestionnaireStep,
  openQuestionnaireReview,
  selectQuestionOption,
  setCustomQuestionAnswer,
  type QuestionnaireRequest,
} from "./model"

const singleRequest: QuestionnaireRequest = {
  requestId: "single",
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
  ],
}

const multiRequest: QuestionnaireRequest = {
  requestId: "multi",
  questions: [
    ...singleRequest.questions,
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

describe("questionnaire model", () => {
  it("submits one question directly but reviews multiple questions", () => {
    const one = selectQuestionOption(
      singleRequest,
      createQuestionnaireDraft(singleRequest),
      "q1",
      "a",
    )
    expect(nextQuestionnaireStep(singleRequest, one).phase).toBe("answering")
    expect(canSubmitQuestionnaire(singleRequest, one)).toBe(true)

    let many = selectQuestionOption(
      multiRequest,
      createQuestionnaireDraft(multiRequest),
      "q1",
      "a",
    )
    many = nextQuestionnaireStep(multiRequest, many)
    expect(many.activeIndex).toBe(1)
    many = selectQuestionOption(multiRequest, many, "q2", "b")
    expect(nextQuestionnaireStep(multiRequest, many).phase).toBe("review")
  })

  it("preserves immutable answers across review and edit", () => {
    const initial = createQuestionnaireDraft(multiRequest)
    const first = selectQuestionOption(multiRequest, initial, "q1", "a")
    const second = selectQuestionOption(multiRequest, first, "q2", "b")
    const reviewed = openQuestionnaireReview(multiRequest, second)
    const edited = editQuestionnaireAnswer(multiRequest, reviewed, "q1")

    expect(edited.phase).toBe("answering")
    expect(edited.answers.q2?.optionId).toBe("b")
    expect(initial.answers).toEqual({})
    expect(first).not.toBe(initial)
    expect(multiRequest.questions[0]?.options).toHaveLength(2)
  })

  it("allows custom text only when the question enables it", () => {
    const enabled = setCustomQuestionAnswer(
      singleRequest,
      createQuestionnaireDraft(singleRequest),
      "q1",
      "  My target  ",
    )
    expect(enabled.answers.q1?.customText).toBe("  My target  ")
    expect(canSubmitQuestionnaire(singleRequest, enabled)).toBe(true)

    const disabled = setCustomQuestionAnswer(
      multiRequest,
      createQuestionnaireDraft(multiRequest),
      "q2",
      "Forbidden",
    )
    expect(disabled.answers.q2).toBeUndefined()
  })
})
