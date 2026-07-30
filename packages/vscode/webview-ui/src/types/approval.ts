export type ApprovalActionType =
  | "write"
  | "execute"
  | "sandbox_escalation"
  | "mcp"
  | "plugin"
  | "browser"
  | "read"
  | "doom_loop"

export interface ApprovalActionView {
  type: ApprovalActionType | string
  tool: string
  description: string
  path?: string
  content?: string
  shortDescription?: string
  warning?: string
  diff?: string
  diffStats?: { added: number; removed: number }
}

export function approvalActionPath(
  action: ApprovalActionView,
): string | null {
  const structured = action.path?.trim()
  if (structured) return structured
  if (action.type !== "write") return null
  const normalized = action.description
    .replace(/^\[Permission Rule\]\s*/iu, "")
    .trim()
  const match =
    /^(?:Write to|Edit|Edit file:|Write file:)\s+(.+)$/iu.exec(normalized)
  return match?.[1]?.trim() || null
}

export function approvalActionLabel(action: ApprovalActionView): string {
  if (action.type === "sandbox_escalation") {
    const command = action.content?.trim()
    return command
      ? `Run once outside OS sandbox: ${command}`
      : "Run this command once outside the OS sandbox"
  }
  if (action.type === "execute") {
    return action.content ? `Run: ${action.content}` : action.description
  }
  if (action.type === "write") return `Edit: ${action.description}`
  return action.description
}

export function approvalActionWarning(
  action: ApprovalActionView,
): string | null {
  if (action.warning?.trim()) return action.warning.trim()
  if (action.type === "sandbox_escalation") {
    return "This exception applies to this exact command once and is never saved."
  }
  return null
}
