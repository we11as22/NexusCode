import React from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  buildQuestionnaireSubmission,
  canSubmitQuestionnaire,
  createQuestionnaireDraft,
  editQuestionnaireAnswer,
  isQuestionnaireOptionSelected,
  moveQuestion,
  nextQuestionnaireStep,
  selectQuestionOption,
  setCustomQuestionAnswer,
  CUSTOM_OPTION_ID,
  type QuestionnaireAnswer,
  type QuestionnaireDraft,
  type QuestionnaireRequest,
} from "./model"

interface QuestionnaireProps {
  request: QuestionnaireRequest
  onDismiss: () => void
  onSubmit: (answers: QuestionnaireAnswer[]) => void
}

function isActiveQuestionAnswered(
  request: QuestionnaireRequest,
  draft: QuestionnaireDraft,
): boolean {
  const question = request.questions[draft.activeIndex]
  if (!question) return false
  const answer = draft.answers[question.id]
  if (answer?.optionId === CUSTOM_OPTION_ID) {
    return question.allowCustom === true && Boolean(answer.customText?.trim())
  }
  return question.multiSelect
    ? Boolean(answer?.optionIds?.length)
    : Boolean(answer?.optionId)
}

function answerSummary(
  request: QuestionnaireRequest,
  answer: QuestionnaireAnswer | undefined,
): string {
  if (!answer) return "Not answered"
  if (answer.optionId === CUSTOM_OPTION_ID) {
    return answer.customText?.trim() || "Not answered"
  }
  if (answer.optionLabels?.length) return answer.optionLabels.join(", ")
  if (answer.optionLabel) return answer.optionLabel
  const question = request.questions.find(
    (candidate) => candidate.id === answer.questionId,
  )
  return (
    question?.options.find((option) => option.id === answer.optionId)?.label ??
    "Not answered"
  )
}

export function Questionnaire({
  request,
  onDismiss,
  onSubmit,
}: QuestionnaireProps): React.ReactNode {
  const [draft, setDraft] = React.useState(() =>
    createQuestionnaireDraft(request),
  )
  const [focusedOptionId, setFocusedOptionId] = React.useState<string | null>(
    request.questions[0]?.options[0]?.id ?? null,
  )
  const submittingRef = React.useRef(false)

  React.useEffect(() => {
    setDraft(createQuestionnaireDraft(request))
    setFocusedOptionId(request.questions[0]?.options[0]?.id ?? null)
    submittingRef.current = false
  }, [request.requestId])

  const question = request.questions[draft.activeIndex]
  const answer = question ? draft.answers[question.id] : undefined
  const customLabel = request.customOptionLabel?.trim() || "Other"
  const showPager = request.questions.length > 1 && draft.phase === "answering"
  const allAnswered = canSubmitQuestionnaire(request, draft)
  const activeAnswered = isActiveQuestionAnswered(request, draft)
  const focusedOption = question?.options.find(
    (option) => option.id === focusedOptionId,
  )

  const submit = React.useCallback(() => {
    if (
      submittingRef.current ||
      !canSubmitQuestionnaire(request, draft)
    ) {
      return
    }
    submittingRef.current = true
    onSubmit(buildQuestionnaireSubmission(request, draft))
  }, [draft, onSubmit, request])

  const continueFlow = React.useCallback(() => {
    if (draft.phase === "review") {
      submit()
      return
    }
    if (!activeAnswered) return
    if (request.questions.length === 1) {
      submit()
      return
    }
    setDraft((current) => nextQuestionnaireStep(request, current))
  }, [activeAnswered, draft.phase, request, submit])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onDismiss()
        return
      }
      if (draft.phase !== "answering") return
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        setDraft((current) => moveQuestion(request, current, -1))
      } else if (event.key === "ArrowRight" && activeAnswered) {
        event.preventDefault()
        setDraft((current) => nextQuestionnaireStep(request, current))
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [activeAnswered, draft.phase, onDismiss, request])

  if (!question && draft.phase !== "review") return null

  return (
    <section
      className="nexus-questionnaire"
      aria-label={request.title?.trim() || "Agent question"}
    >
      {draft.phase === "review" ? (
        <>
          <header className="nexus-questionnaire-header">
            <div>
              <div className="nexus-questionnaire-title">
                {request.title?.trim() || "Review your answers"}
              </div>
              <div className="nexus-questionnaire-subtitle">
                Check the answers before continuing.
              </div>
            </div>
          </header>
          <div className="nexus-questionnaire-review">
            {request.questions.map((item) => (
              <div className="nexus-questionnaire-review-row" key={item.id}>
                <div className="nexus-questionnaire-review-copy">
                  <div className="nexus-questionnaire-review-question">
                    {item.question}
                  </div>
                  <div className="nexus-questionnaire-review-answer">
                    {answerSummary(request, draft.answers[item.id])}
                  </div>
                </div>
                <button
                  type="button"
                  className="nexus-questionnaire-edit"
                  onClick={() =>
                    setDraft((current) =>
                      editQuestionnaireAnswer(request, current, item.id),
                    )
                  }
                >
                  Edit
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <header className="nexus-questionnaire-header">
            <div className="nexus-questionnaire-header-text">
              {request.title?.trim() &&
              request.title.trim() !== "Asking questions" ? (
                <div className="nexus-questionnaire-kicker">
                  {request.title.trim()}
                </div>
              ) : null}
              <div className="nexus-questionnaire-title-row">
                {question?.header?.trim() ? (
                  <span className="nexus-questionnaire-header-chip">
                    {question.header.trim()}
                  </span>
                ) : null}
                <span className="nexus-questionnaire-title">
                  {question?.question}
                </span>
              </div>
            </div>
            {showPager ? (
              <nav
                className="nexus-questionnaire-pager"
                aria-label="Question navigation"
              >
                <button
                  type="button"
                  className="nexus-questionnaire-nav"
                  onClick={() =>
                    setDraft((current) => moveQuestion(request, current, -1))
                  }
                  disabled={draft.activeIndex === 0}
                  aria-label="Previous question"
                >
                  ‹
                </button>
                <span className="nexus-questionnaire-pager-label">
                  {draft.activeIndex + 1} of {request.questions.length}
                </span>
                <button
                  type="button"
                  className="nexus-questionnaire-nav"
                  onClick={() =>
                    setDraft((current) => nextQuestionnaireStep(request, current))
                  }
                  disabled={!activeAnswered}
                  aria-label="Next question"
                >
                  ›
                </button>
              </nav>
            ) : null}
          </header>
          <div
            className={`nexus-questionnaire-body ${
              focusedOption?.preview
                ? "nexus-questionnaire-body--with-preview"
                : ""
            }`}
          >
            <fieldset className="nexus-questionnaire-options">
              <legend className="sr-only">{question?.question}</legend>
              {question?.options.map((option, index) => {
                const selected = isQuestionnaireOptionSelected(
                  draft,
                  question.id,
                  option.id,
                )
                return (
                  <label
                    className={`nexus-questionnaire-option ${
                      selected ? "nexus-questionnaire-option-active" : ""
                    }`}
                    key={option.id}
                    onMouseEnter={() => setFocusedOptionId(option.id)}
                  >
                    <input
                      type={question.multiSelect ? "checkbox" : "radio"}
                      name={`nexus-question-${question.id}`}
                      checked={selected}
                      onChange={() => {
                        setFocusedOptionId(option.id)
                        setDraft((current) =>
                          selectQuestionOption(
                            request,
                            current,
                            question.id,
                            option.id,
                          ),
                        )
                      }}
                    />
                    <span className="nexus-questionnaire-option-num">
                      {index + 1}.
                    </span>
                    <span className="nexus-questionnaire-option-copy">
                      <span className="nexus-questionnaire-option-label">
                        {option.label}
                      </span>
                      {option.description?.trim() ? (
                        <span className="nexus-questionnaire-option-desc">
                          {option.description.trim()}
                        </span>
                      ) : null}
                    </span>
                  </label>
                )
              })}
              {question?.allowCustom === true ? (
                <label
                  className={`nexus-questionnaire-option nexus-questionnaire-option--custom ${
                    answer?.optionId === CUSTOM_OPTION_ID
                      ? "nexus-questionnaire-option-active"
                      : ""
                  }`}
                >
                  <input
                    type={question.multiSelect ? "checkbox" : "radio"}
                    name={`nexus-question-${question.id}`}
                    checked={answer?.optionId === CUSTOM_OPTION_ID}
                    onChange={() =>
                      setDraft((current) =>
                        setCustomQuestionAnswer(
                          request,
                          current,
                          question.id,
                          current.answers[question.id]?.customText ?? "",
                        ),
                      )
                    }
                  />
                  <span className="nexus-questionnaire-option-num">
                    {question.options.length + 1}.
                  </span>
                  <span className="nexus-questionnaire-option-copy">
                    <span className="nexus-questionnaire-option-label">
                      {customLabel}
                    </span>
                    {answer?.optionId === CUSTOM_OPTION_ID ? (
                      <textarea
                        className="nexus-questionnaire-custom-input"
                        aria-label={`${customLabel} answer`}
                        autoFocus
                        value={answer.customText ?? ""}
                        onChange={(event) =>
                          setDraft((current) =>
                            setCustomQuestionAnswer(
                              request,
                              current,
                              question.id,
                              event.target.value,
                            ),
                          )
                        }
                        placeholder="Type your answer"
                        rows={2}
                      />
                    ) : null}
                  </span>
                </label>
              ) : null}
            </fieldset>
            {focusedOption?.preview?.trim() ? (
              <div className="nexus-questionnaire-preview">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {focusedOption.preview}
                </ReactMarkdown>
              </div>
            ) : null}
          </div>
        </>
      )}
      <footer className="nexus-questionnaire-footer">
        {draft.phase === "answering" && draft.activeIndex > 0 ? (
          <button
            type="button"
            className="nexus-questionnaire-back"
            onClick={() =>
              setDraft((current) => moveQuestion(request, current, -1))
            }
          >
            Back
          </button>
        ) : (
          <span />
        )}
        <div className="nexus-questionnaire-footer-actions">
          <button
            type="button"
            className="nexus-questionnaire-dismiss"
            onClick={onDismiss}
          >
            Dismiss <kbd className="nexus-kbd">Esc</kbd>
          </button>
          <button
            type="button"
            className="nexus-questionnaire-continue"
            onClick={continueFlow}
            disabled={draft.phase === "review" ? !allAnswered : !activeAnswered}
          >
            {draft.phase === "review" || request.questions.length === 1
              ? request.submitLabel?.trim() || "Continue"
              : draft.activeIndex === request.questions.length - 1
                ? "Review"
                : "Continue"}
          </button>
        </div>
      </footer>
    </section>
  )
}
