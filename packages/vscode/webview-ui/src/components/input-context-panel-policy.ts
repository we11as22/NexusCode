export type InputContextPanelKind = "none" | "applied-changes"

export function inputContextPanelKind(input: {
  readonly hasPendingApproval: boolean
  readonly mode: string
  readonly appliedEditCount: number
}): InputContextPanelKind {
  if (input.hasPendingApproval) return "none"
  if (
    input.appliedEditCount > 0 &&
    (input.mode === "agent" ||
      input.mode === "plan" ||
      input.mode === "debug")
  ) {
    return "applied-changes"
  }
  return "none"
}
