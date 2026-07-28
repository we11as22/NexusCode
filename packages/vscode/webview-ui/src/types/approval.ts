export type ApprovalActionType =
  | "write"
  | "execute"
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
