import { describe, expect, it } from "vitest"

import {
  assertAgentExecutionIdentity,
  delegatedAgentExecutionIdentity,
  toolExecutionIdentity,
} from "./execution-identity.js"

describe("agent execution identity", () => {
  it("binds exact message, part, and tool-call ids without mutating the base", () => {
    const base = {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
    }
    const exact = toolExecutionIdentity(base, {
      messageId: "message-1",
      partId: "part-1",
      toolCallId: "tool-1",
    })

    expect(exact).toEqual({
      ...base,
      messageId: "message-1",
      partId: "part-1",
      toolCallId: "tool-1",
    })
    expect(Object.isFrozen(exact)).toBe(true)
    expect(base).toEqual({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      runId: "run-1",
    })
  })

  it("derives bounded deterministic but distinct delegated run lineage", () => {
    const parent = toolExecutionIdentity({
      workspaceId: "workspace-1",
      sessionId: "root-session",
      turnId: `turn-${"x".repeat(480)}`,
      runId: "root-run",
    }, {
      messageId: "message-1",
      partId: "part-1",
      toolCallId: "spawn-1",
    })

    const first = delegatedAgentExecutionIdentity(parent, {
      sessionId: "child-session",
      subagentId: "agent-1",
    })
    const repeated = delegatedAgentExecutionIdentity(parent, {
      sessionId: "child-session",
      subagentId: "agent-1",
    })
    const second = delegatedAgentExecutionIdentity(parent, {
      sessionId: "child-session-2",
      subagentId: "agent-2",
    })

    expect(first).toEqual(repeated)
    expect(first.workspaceId).toBe(parent.workspaceId)
    expect(first.sessionId).toBe("child-session")
    expect(first.runId).toBe("agent-1")
    expect(first.turnId.length).toBeLessThan(128)
    expect(second.turnId).not.toBe(first.turnId)
  })

  it("rejects missing, oversized, or NUL-bearing identity fields", () => {
    expect(() =>
      assertAgentExecutionIdentity({
        workspaceId: "",
        sessionId: "session",
        turnId: "turn",
        runId: "run",
      }),
    ).toThrow(/workspaceId/i)
    expect(() =>
      toolExecutionIdentity({
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        runId: "run",
      }, {
        messageId: "message",
        partId: "part\0bad",
        toolCallId: "tool",
      }),
    ).toThrow(/partId/i)
  })
})
