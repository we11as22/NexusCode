import {
  NEXUS_CUSTOM_OPTION_ID,
  type UserQuestionAnswer,
  type UserQuestionItem,
  type UserQuestionRequest,
} from "@nexuscode/core"

export type QuestionnairePhase = "answering" | "review"

export interface QuestionnaireDraft {
  requestId: string
  activeIndex: number
  phase: QuestionnairePhase
  answers: Record<string, UserQuestionAnswer>
  submitted: boolean
}

export function createQuestionnaireDraft(
  request: UserQuestionRequest,
): QuestionnaireDraft {
  return {
    requestId: request.requestId,
    activeIndex: 0,
    phase: "answering",
    answers: {},
    submitted: false,
  }
}

function currentDraft(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
): QuestionnaireDraft {
  return draft.requestId === request.requestId
    ? draft
    : createQuestionnaireDraft(request)
}

function stoppedDraft(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
): QuestionnaireDraft | undefined {
  const current = currentDraft(request, draft)
  return current.submitted ? current : undefined
}

function findQuestion(
  request: UserQuestionRequest,
  questionId: string,
): UserQuestionItem | undefined {
  return request.questions.find((question) => question.id === questionId)
}

function isAnswered(
  question: UserQuestionItem,
  answer: UserQuestionAnswer | undefined,
): boolean {
  if (!answer) return false
  if (answer.optionId === NEXUS_CUSTOM_OPTION_ID) {
    return question.allowCustom === true && Boolean(answer.customText?.trim())
  }
  return question.multiSelect
    ? Boolean(answer.optionIds?.length)
    : Boolean(answer.optionId)
}

export function selectQuestionOption(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
  questionId: string,
  optionId: string,
): QuestionnaireDraft {
  const stopped = stoppedDraft(request, draft)
  if (stopped) return stopped
  const current = currentDraft(request, draft)
  const question = findQuestion(request, questionId)
  const option = question?.options.find((candidate) => candidate.id === optionId)
  if (!question || !option) return current

  let answer: UserQuestionAnswer
  if (question.multiSelect) {
    const previous =
      current.answers[questionId]?.optionId === NEXUS_CUSTOM_OPTION_ID
        ? []
        : current.answers[questionId]?.optionIds ?? []
    const optionIds = previous.includes(optionId)
      ? previous.filter((id) => id !== optionId)
      : [...previous, optionId]
    answer = {
      questionId,
      optionIds,
      optionLabels: optionIds
        .map((id) => question.options.find((item) => item.id === id)?.label)
        .filter((label): label is string => Boolean(label)),
    }
  } else {
    answer = { questionId, optionId, optionLabel: option.label }
  }
  return {
    ...current,
    phase: "answering",
    answers: { ...current.answers, [questionId]: answer },
  }
}

export function setCustomQuestionAnswer(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
  questionId: string,
  customText: string,
): QuestionnaireDraft {
  const stopped = stoppedDraft(request, draft)
  if (stopped) return stopped
  const current = currentDraft(request, draft)
  const question = findQuestion(request, questionId)
  if (!question || question.allowCustom !== true) return current
  return {
    ...current,
    phase: "answering",
    answers: {
      ...current.answers,
      [questionId]: {
        questionId,
        optionId: NEXUS_CUSTOM_OPTION_ID,
        optionLabel: request.customOptionLabel?.trim() || "Other",
        customText,
      },
    },
  }
}

export function moveQuestion(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
  direction: -1 | 1,
): QuestionnaireDraft {
  const stopped = stoppedDraft(request, draft)
  if (stopped) return stopped
  const current = currentDraft(request, draft)
  return {
    ...current,
    phase: "answering",
    activeIndex: Math.max(
      0,
      Math.min(request.questions.length - 1, current.activeIndex + direction),
    ),
  }
}

export function canSubmitQuestionnaire(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
): boolean {
  const current = currentDraft(request, draft)
  return (
    !current.submitted &&
    request.questions.length > 0 &&
    request.questions.every((question) =>
      isAnswered(question, current.answers[question.id]),
    )
  )
}

export function openQuestionnaireReview(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
): QuestionnaireDraft {
  const stopped = stoppedDraft(request, draft)
  if (stopped) return stopped
  const current = currentDraft(request, draft)
  return request.questions.length > 1 &&
    canSubmitQuestionnaire(request, current)
    ? { ...current, phase: "review" }
    : current
}

export function nextQuestionnaireStep(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
): QuestionnaireDraft {
  const stopped = stoppedDraft(request, draft)
  if (stopped) return stopped
  const current = currentDraft(request, draft)
  const question = request.questions[current.activeIndex]
  if (!question || !isAnswered(question, current.answers[question.id])) {
    return current
  }
  if (current.activeIndex < request.questions.length - 1) {
    return { ...current, activeIndex: current.activeIndex + 1 }
  }
  return openQuestionnaireReview(request, current)
}

export function editQuestionnaireAnswer(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
  questionId: string,
): QuestionnaireDraft {
  const stopped = stoppedDraft(request, draft)
  if (stopped) return stopped
  const current = currentDraft(request, draft)
  const activeIndex = request.questions.findIndex(
    (question) => question.id === questionId,
  )
  return activeIndex < 0
    ? current
    : { ...current, activeIndex, phase: "answering" }
}

export function isQuestionnaireOptionSelected(
  draft: QuestionnaireDraft,
  questionId: string,
  optionId: string,
): boolean {
  const answer = draft.answers[questionId]
  return (
    answer?.optionId === optionId ||
    Boolean(answer?.optionIds?.includes(optionId))
  )
}

export function buildQuestionnaireSubmission(
  request: UserQuestionRequest,
  draft: QuestionnaireDraft,
): UserQuestionAnswer[] {
  const current = currentDraft(request, draft)
  if (!canSubmitQuestionnaire(request, current)) {
    throw new Error("Answer every question before submitting.")
  }
  return request.questions.map((question) => ({
    ...current.answers[question.id]!,
  }))
}
