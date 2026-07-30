export type PlanKeyboardAction =
  | "none"
  | "submit"
  | { select: 0 | 1 | 2 }

export interface PlanKeyboardInput {
  readonly key: string
  readonly targetTag?: string
  readonly targetEditable?: boolean
  readonly canSubmit: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
}

/** Cursor-style Plan decisions without stealing multiline feedback editing. */
export function planKeyboardAction(
  input: PlanKeyboardInput,
): PlanKeyboardAction {
  const tag = input.targetTag?.toLowerCase() ?? ""
  const editing =
    input.targetEditable === true ||
    tag === "textarea" ||
    tag === "input"
  const nativeButton = tag === "button"

  if (input.key === "Enter") {
    if (editing && !(input.ctrlKey || input.metaKey)) return "none"
    if (nativeButton || !input.canSubmit) return "none"
    return "submit"
  }
  if (editing || nativeButton) return "none"
  if (input.key === "1") return { select: 0 }
  if (input.key === "2") return { select: 1 }
  if (input.key === "3") return { select: 2 }
  return "none"
}
