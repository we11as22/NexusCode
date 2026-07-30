import type { Mode } from "../types.js"

export type NonPlanMode = Exclude<Mode, "plan">

export interface SessionModeState {
  readonly mode: Mode
  readonly planReturnMode?: NonPlanMode
}

/**
 * Durable Plan-mode transition shared by the local and server runtimes.
 * Revisions stay in Plan and preserve the original return mode; an explicit
 * exit clears that pending return target.
 */
export function transitionSessionMode(
  currentMode: Mode | undefined,
  currentPlanReturnMode: NonPlanMode | undefined,
  nextMode: Mode,
): SessionModeState {
  if (nextMode === "plan") {
    return {
      mode: nextMode,
      planReturnMode:
        currentMode === "plan"
          ? currentPlanReturnMode ?? "agent"
          : currentMode ?? "agent",
    }
  }
  return { mode: nextMode }
}
