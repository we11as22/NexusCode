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
  content?: string
  shortDescription?: string
  warning?: string
  diff?: string
  diffStats?: { added: number; removed: number }
}
