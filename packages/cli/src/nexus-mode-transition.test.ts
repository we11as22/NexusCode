import { describe, expect, it, vi } from "vitest"

import {
  commitNexusModeTransition,
  nexusModeMessageFromAgentEvent,
} from "./nexus-mode-transition.js"

describe("Nexus mode transitions", () => {
  it("accepts only a successful EnterPlanMode result from the agent event stream", () => {
    expect(nexusModeMessageFromAgentEvent({
      type: "tool_end",
      tool: "EnterPlanMode",
      partId: "part-plan",
      messageId: "message-plan",
      success: true,
      output: "plan",
      metadata: {
        modeChange: {
          success: true,
          mode: "plan",
        },
      },
    })).toEqual({ type: "nexus_mode", mode: "plan" })

    expect(nexusModeMessageFromAgentEvent({
      type: "tool_end",
      tool: "EnterPlanMode",
      partId: "part-failed",
      messageId: "message-failed",
      success: false,
      output: "rejected",
      metadata: {
        modeChange: {
          success: true,
          mode: "plan",
        },
      },
    })).toBeNull()

    expect(nexusModeMessageFromAgentEvent({
      type: "tool_end",
      tool: "OtherTool",
      partId: "part-spoofed",
      messageId: "message-spoofed",
      success: true,
      output: "spoofed",
      metadata: {
        modeChange: {
          success: true,
          mode: "plan",
        },
      },
    })).toBeNull()
  })

  it("persists the accepted mode for the next turn and clears a stale one-shot override", () => {
    const nexus = { mode: "agent" as const }
    const forced = { current: "debug" as string | null }
    const setMode = vi.fn()

    expect(commitNexusModeTransition(
      nexus,
      forced,
      { type: "nexus_mode", mode: "plan" },
      setMode,
    )).toBe(true)

    expect(nexus.mode).toBe("plan")
    expect(forced.current).toBeNull()
    expect(setMode).toHaveBeenCalledWith("plan")
  })
})
