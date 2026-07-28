import { describe, expect, it } from "vitest"

import { createFakeSession } from "../test/fakes.js"
import { planExitWriteGateSatisfied } from "./plan-write-gate.js"

describe("plan write gate", () => {
  it("requires the plan-file write in the current turn to complete", () => {
    const cwd = "/workspace"
    const session = createFakeSession(cwd)
    const message = session.addMessage({
      role: "assistant",
      content: [{
        type: "tool",
        id: "write-plan",
        tool: "Write",
        input: {
          file_path: ".nexus/plans/demo.md",
          content: "# Demo",
        },
        status: "running",
      }],
    })

    expect(planExitWriteGateSatisfied(session, message.id, cwd)).toBe(false)

    const part = Array.isArray(message.content) ? message.content[0] : undefined
    if (part?.type === "tool") part.status = "completed"

    expect(planExitWriteGateSatisfied(session, message.id, cwd)).toBe(true)
  })
})
