export type QuestionnaireKeyboardAction =
  | "none"
  | "continue"
  | { selectOption: number }

export interface QuestionnaireKeyboardInput {
  key: string
  targetTag?: string
  targetEditable?: boolean
  activeAnswered: boolean
  optionCount?: number
  ctrlKey?: boolean
  metaKey?: boolean
}

/**
 * Cursor-style global shortcuts without stealing normal text editing or the
 * browser's native button/radio activation.
 */
export function questionnaireKeyboardAction(
  input: QuestionnaireKeyboardInput,
): QuestionnaireKeyboardAction {
  const tag = input.targetTag?.toLowerCase() ?? ""
  const editingText =
    input.targetEditable === true ||
    tag === "textarea" ||
    tag === "input"
  const nativeActivation = tag === "button"

  if (input.key === "Enter") {
    if (
      editingText &&
      !(input.activeAnswered && (input.ctrlKey || input.metaKey))
    ) {
      return "none"
    }
    if (nativeActivation || !input.activeAnswered) return "none"
    return "continue"
  }

  if (editingText || nativeActivation) return "none"
  if (/^[1-9]$/.test(input.key)) {
    const optionIndex = Number(input.key) - 1
    if (optionIndex < Math.max(0, input.optionCount ?? 0)) {
      return { selectOption: optionIndex }
    }
  }
  return "none"
}
