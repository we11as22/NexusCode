import type { Mode } from "../types.js"

/**
 * Input-sensitive mode boundaries must run before hooks, approvals, or any
 * side effect. Tool-name allowlists alone are insufficient for composite
 * tools such as TaskCreate, whose schema can launch shell/worktree work.
 */
export function modeSpecificToolInputError(
  mode: Mode,
  toolName: string,
  toolInput: Record<string, unknown>,
): string | undefined {
  if (toolName !== "TaskCreate") return undefined
  const kind =
    typeof toolInput["kind"] === "string"
      ? toolInput["kind"]
      : "tracking"
  const isolation = toolInput["isolation"]

  if (mode === "review") {
    return "TaskCreate is disabled in review mode."
  }
  if (mode === "ask" && kind !== "agent") {
    return (
      "Ask mode may use TaskCreate only for a read-only delegated agent; " +
      `kind=${kind} is not allowed.`
    )
  }
  if (
    (mode === "ask" || mode === "plan") &&
    isolation === "worktree"
  ) {
    return `${mode} mode cannot create a task worktree.`
  }
  if (
    (mode === "ask" || mode === "plan") &&
    kind === "shell"
  ) {
    return `${mode} mode cannot launch a shell task.`
  }
  return undefined
}
