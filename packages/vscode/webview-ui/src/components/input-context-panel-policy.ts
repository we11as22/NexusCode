export type InputContextPanelKind = "none" | "applied-changes"

export function uniqueEditedFileCount(
  edits: readonly { readonly path: string }[],
): number {
  return new Set(
    edits
      .map((edit) => edit.path.replace(/\\/gu, "/").trim())
      .filter(Boolean),
  ).size
}

export function appliedFileLabel(
  edits: readonly { readonly path: string }[],
): string {
  const count = uniqueEditedFileCount(edits)
  return count === 1 ? "1 File" : `${count} Files`
}

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
