export type PlanKeyboardAction =
  | "none"
  | "submit"
  | "dismiss"
  | { select: 0 | 1 }

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
  if (input.key === "Escape" && !editing) return "dismiss"
  if (editing || nativeButton) return "none"
  if (input.key === "1") return { select: 0 }
  if (input.key === "2") return { select: 1 }
  return "none"
}
