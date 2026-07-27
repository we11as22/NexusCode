import type { AgentEvent, Mode } from "@nexuscode/core"

export type NexusModeMessage = {
  type: "nexus_mode"
  mode: Mode
}

export function nexusModeMessageFromAgentEvent(
  event: AgentEvent,
): NexusModeMessage | null {
  if (
    event.type !== "tool_end" ||
    event.tool !== "EnterPlanMode" ||
    event.success !== true
  ) {
    return null
  }
  const metadata =
    event.metadata &&
    typeof event.metadata === "object" &&
    !Array.isArray(event.metadata)
      ? event.metadata as Record<string, unknown>
      : null
  const modeChange =
    metadata?.["modeChange"] &&
    typeof metadata["modeChange"] === "object" &&
    !Array.isArray(metadata["modeChange"])
      ? metadata["modeChange"] as Record<string, unknown>
      : null
  if (
    modeChange?.["success"] !== true ||
    modeChange["mode"] !== "plan"
  ) {
    return null
  }
  return { type: "nexus_mode", mode: "plan" }
}

export function commitNexusModeTransition(
  nexus: { mode: Mode } | null | undefined,
  forcedModeForNextRun: { current: string | null },
  message: NexusModeMessage,
  setMode: (mode: Mode) => void,
): boolean {
  if (!nexus) return false
  nexus.mode = message.mode
  forcedModeForNextRun.current = null
  setMode(message.mode)
  return true
}
