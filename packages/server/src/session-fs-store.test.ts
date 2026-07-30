import { describe, expect, it } from "vitest"

import type { StoredSession } from "@nexuscode/core"
import { applySessionModeUpdate } from "./session-fs-store.js"

describe("server session mode persistence", () => {
  it("atomically consumes a plan handoff with its mode transition", () => {
    const stored: StoredSession = {
      id: "session-plan",
      cwd: "/tmp/project",
      ts: 1,
      messages: [
        {
          id: "assistant-plan",
          ts: 1,
          role: "assistant",
          content: [
            {
              type: "tool",
              id: "plan-exit",
              tool: "PlanExit",
              status: "completed",
            },
          ],
        },
      ],
    }

    const updated = applySessionModeUpdate(
      stored,
      "agent",
      undefined,
      "implemented",
      2,
    )

    expect(updated).toEqual({
      ...stored,
      mode: "agent",
      planReturnMode: undefined,
      ts: 2,
      messages: [
        {
          id: "assistant-plan",
          ts: 1,
          role: "assistant",
          content: [
            {
              type: "tool",
              id: "plan-exit",
              tool: "PlanExit",
              status: "completed",
              planFollowupResolution: "implemented",
            },
          ],
        },
      ],
    })
    expect(stored.messages[0]?.content).not.toEqual(
      updated.messages[0]?.content,
    )
  })
})
