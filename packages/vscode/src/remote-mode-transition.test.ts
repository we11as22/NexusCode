import { describe, expect, it } from "vitest"
import type { AgentEvent } from "@nexuscode/core"

import {
  remoteModeTransitionFromAgentEvent,
} from "./remote-mode-transition.js"

function toolEnd(
  overrides: Partial<Extract<AgentEvent, { type: "tool_end" }>> = {},
): Extract<AgentEvent, { type: "tool_end" }> {
  return {
    type: "tool_end",
    tool: "EnterPlanMode",
    partId: "part-plan",
    messageId: "message-plan",
    success: true,
    output: "Entered plan mode.",
    metadata: {
      modeChange: {
        success: true,
        mode: "plan",
      },
    },
    ...overrides,
  }
}

describe("remote VS Code mode transitions", () => {
  it("accepts an authenticated successful EnterPlanMode result", () => {
    expect(
      remoteModeTransitionFromAgentEvent(toolEnd()),
    ).toBe("plan")
  })

  it("rejects failed, spoofed, and malformed mode metadata", () => {
    expect(
      remoteModeTransitionFromAgentEvent(
        toolEnd({ success: false }),
      ),
    ).toBeNull()
    expect(
      remoteModeTransitionFromAgentEvent(
        toolEnd({ tool: "OtherTool" }),
      ),
    ).toBeNull()
    expect(
      remoteModeTransitionFromAgentEvent(
        toolEnd({
          metadata: {
            modeChange: {
              success: false,
              mode: "plan",
            },
          },
        }),
      ),
    ).toBeNull()
    expect(
      remoteModeTransitionFromAgentEvent(
        toolEnd({
          metadata: {
            modeChange: {
              success: true,
              mode: "agent",
            },
          },
        }),
      ),
    ).toBeNull()
    expect(
      remoteModeTransitionFromAgentEvent(
        toolEnd({
          metadata: {
            modeChange: "plan",
          },
        }),
      ),
    ).toBeNull()
    expect(
      remoteModeTransitionFromAgentEvent({
        type: "done",
        messageId: "message-plan",
      }),
    ).toBeNull()
  })
})
