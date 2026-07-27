import type { AgentEvent, Mode } from "@nexuscode/core"

function record(value: unknown): Record<string, unknown> | null {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    ? value as Record<string, unknown>
    : null
}

/**
 * Accept the server-authenticated mode transition only when both the outer
 * tool result and its structured host result agree. Arbitrary tool metadata,
 * failed EnterPlanMode calls, and malformed payloads cannot change UI state.
 */
export function remoteModeTransitionFromAgentEvent(
  event: AgentEvent,
): Mode | null {
  if (
    event.type !== "tool_end" ||
    event.tool !== "EnterPlanMode" ||
    event.success !== true
  ) {
    return null
  }
  const metadata = record(event.metadata)
  const modeChange = record(metadata?.["modeChange"])
  if (
    modeChange?.["success"] !== true ||
    modeChange["mode"] !== "plan"
  ) {
    return null
  }
  return "plan"
}
