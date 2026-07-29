export const CUSTOM_OPTION_ID = "__nexus_other__"

export interface QuestionnaireOption {
  id: string
  label: string
  description?: string
  preview?: string
}

export interface QuestionnaireQuestion {
  id: string
  question: string
  header?: string
  multiSelect?: boolean
  options: QuestionnaireOption[]
  allowCustom?: boolean
}

export interface QuestionnaireRequest {
  requestId: string
  title?: string
  submitLabel?: string
  customOptionLabel?: string
  questions: QuestionnaireQuestion[]
}

export interface QuestionnaireAnswer {
  questionId: string
  optionId?: string
  optionIds?: string[]
  optionLabel?: string
  optionLabels?: string[]
  customText?: string
}

export type QuestionnairePhase = "answering" | "review"

export interface QuestionnaireDraft {
  requestId: string
  activeIndex: number
  phase: QuestionnairePhase
  answers: Record<string, QuestionnaireAnswer>
  submitted: boolean
}

export function createQuestionnaireDraft(
  request: QuestionnaireRequest,
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
  request: QuestionnaireRequest,
  draft: QuestionnaireDraft,
): QuestionnaireDraft {
  return draft.requestId === request.requestId
    ? draft
    : createQuestionnaireDraft(request)
}

function unchangedOrReset(
  request: QuestionnaireRequest,
  draft: QuestionnaireDraft,
): QuestionnaireDraft | undefined {
  const current = currentDraft(request, draft)
  return current.submitted ? current : undefined
}

function findQuestion(
  request: QuestionnaireRequest,
  questionId: string,
): QuestionnaireQuestion | undefined {
  return request.questions.find((question) => question.id === questionId)
}

function isAnswered(
  question: QuestionnaireQuestion,
  answer: QuestionnaireAnswer | undefined,
): boolean {
  if (!answer) return false
  if (answer.optionId === CUSTOM_OPTION_ID) {
    return question.allowCustom === true && Boolean(answer.customText?.trim())
  }
  if (question.multiSelect) {
    return Boolean(answer.optionIds?.length)
  }
  return Boolean(answer.optionId)
}

export function selectQuestionOption(
  request: QuestionnaireRequest,
  draft: QuestionnaireDraft,
  questionId: string,
  optionId: string,
): QuestionnaireDraft {
  const stopped = unchangedOrReset(request, draft)
  if (stopped) return stopped
  const current = currentDraft(request, draft)
  const question = findQuestion(request, questionId)
  const option = question?.options.find((candidate) => candidate.id === optionId)
  if (!question || !option) return current

  let answer: QuestionnaireAnswer
  if (question.multiSelect) {
    const previous =
      current.answers[questionId]?.optionId === CUSTOM_OPTION_ID
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
    answer = {
      questionId,
      optionId,
      optionLabel: option.label,
    }
  }

  return {
    ...current,
    phase: "answering",
    answers: { ...current.answers, [questionId]: answer },
  }
}

export function setCustomQuestionAnswer(
  request: QuestionnaireRequest,
  draft: QuestionnaireDraft,
  questionId: string,
  customText: string,
): QuestionnaireDraft {
  const stopped = unchangedOrReset(request, draft)
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
        optionId: CUSTOM_OPTION_ID,
        optionLabel: request.customOptionLabel?.trim() || "Other",
        customText,
      },
    },
  }
}

export function moveQuestion(
  request: QuestionnaireRequest,
  draft: QuestionnaireDraft,
  direction: -1 | 1,
): QuestionnaireDraft {
  const stopped = unchangedOrReset(request, draft)
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
  request: QuestionnaireRequest,
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
  request: QuestionnaireRequest,
  draft: QuestionnaireDraft,
): QuestionnaireDraft {
  const stopped = unchangedOrReset(request, draft)
  if (stopped) return stopped
  const current = currentDraft(request, draft)
  if (request.questions.length < 2 || !canSubmitQuestionnaire(request, current)) {
    return current
  }
  return { ...current, phase: "review" }
}

export function nextQuestionnaireStep(
  request: QuestionnaireRequest,
  draft: QuestionnaireDraft,
): QuestionnaireDraft {
  const stopped = unchangedOrReset(request, draft)
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
  request: QuestionnaireRequest,
  draft: QuestionnaireDraft,
  questionId: string,
): QuestionnaireDraft {
  const stopped = unchangedOrReset(request, draft)
  if (stopped) return stopped
  const current = currentDraft(request, draft)
  const activeIndex = request.questions.findIndex(
    (question) => question.id === questionId,
  )
  if (activeIndex < 0) return current
  return { ...current, activeIndex, phase: "answering" }
}

export function isQuestionnaireOptionSelected(
  draft: QuestionnaireDraft,
  questionId: string,
  optionId: string,
): boolean {
  const answer = draft.answers[questionId]
  return answer?.optionId === optionId || Boolean(answer?.optionIds?.includes(optionId))
}

export function buildQuestionnaireSubmission(
  request: QuestionnaireRequest,
  draft: QuestionnaireDraft,
): QuestionnaireAnswer[] {
  const current = currentDraft(request, draft)
  if (!canSubmitQuestionnaire(request, current)) {
    throw new Error("Answer every question before submitting.")
  }
  return request.questions.map((question) => ({ ...current.answers[question.id]! }))
}
