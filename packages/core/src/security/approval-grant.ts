import type { ApprovalAction } from "../types.js"

function normalizeApprovalCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ")
}

/**
 * Session-scoped "always allow" grants must not widen one approved command
 * into blanket authority for every invocation of the same shell tool.
 */
export function approvalGrantKey(action: ApprovalAction): string {
  const base = `${action.type}:${action.tool}`
  if (action.type !== "execute") return base
  const command = normalizeApprovalCommand(
    action.content?.trim() || action.description,
  )
  return `${base}:${command}`
}
