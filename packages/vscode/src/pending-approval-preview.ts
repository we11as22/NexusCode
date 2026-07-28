import type { AgentEvent } from "@nexuscode/core"

export interface PendingWriteApprovalPreview {
  readonly partId: string
  readonly path: string
  readonly content: string
}

function legacyWriteApprovalPath(description: string): string | null {
  const normalized = description
    .replace(/^\[Permission Rule\]\s*/iu, "")
    .trim()
  const match = /^(?:Write to|Edit)\s+(.+)$/iu.exec(normalized)
  return match?.[1]?.trim() || null
}

/**
 * Converts the authoritative approval event into an exact local preview.
 * `description` is parsed only for compatibility with older Nexus servers;
 * current runtimes always send the structured `path`.
 */
export function pendingWriteApprovalPreviewFromEvent(
  event: AgentEvent,
): PendingWriteApprovalPreview | null {
  if (
    event.type !== "tool_approval_needed" ||
    event.action.type !== "write" ||
    typeof event.action.content !== "string"
  ) {
    return null
  }
  const filePath =
    event.action.path?.trim() ||
    legacyWriteApprovalPath(event.action.description)
  if (!filePath) return null
  return {
    partId: event.partId,
    path: filePath,
    content: event.action.content,
  }
}
