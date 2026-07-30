import { describe, expect, it, vi } from "vitest"

import { createFakeHost, createFakeSession, createTestConfig } from "../../test/fakes.js"
import { bashTool } from "../../tools/built-in/execute-command.js"
import type { ToolContext } from "../../types.js"
import { createNexusRunServices } from "../run-services.js"
import { executeToolPipeline } from "../tool-pipeline.js"

describe("OS sandbox one-shot escalation", () => {
  it("retries the exact denied command once and never persists the grant", async () => {
    const runCommand = vi.fn().mockResolvedValue({
      stdout: "escalated",
      stderr: "",
      exitCode: 0,
    })
    const runSandboxedCommand = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "Operation not permitted",
      exitCode: 1,
      sandbox: "seatbelt",
      timedOut: false,
      denied: true,
    })
    const host = createFakeHost({
      cwd: "/workspace",
      runCommand,
      runSandboxedCommand,
      async showApprovalDialog(action) {
        return {
          approved: true,
          // These must be ignored for sandbox escalation.
          alwaysApprove: true,
          skipAll: true,
          addToAllowedCommand:
            action.type === "sandbox_escalation" ? "touch /outside" : undefined,
        }
      },
    })
    const context: ToolContext = {
      cwd: "/workspace",
      host,
      session: createFakeSession("/workspace"),
      config: createTestConfig({
        permissions: { autoApproveCommand: true },
      }),
      services: createNexusRunServices(),
      executionIdentityBase: {
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        runId: "run",
      },
      mode: "agent",
      signal: new AbortController().signal,
    }

    const result = await executeToolPipeline(
      {
        callId: "call",
        messageId: "message",
        partId: "part_call",
        toolName: "Bash",
        input: { command: "touch /outside" },
        origin: "native",
      },
      {
        tools: [bashTool],
        context,
        autoApproveActions: new Set(["execute"]),
        mode: "agent",
        mcpToolNames: new Set(),
        async hookRunner() {
          return []
        },
      },
    )

    expect(result.success).toBe(true)
    expect(result.output).toContain("escalated")
    expect(runSandboxedCommand).toHaveBeenCalledTimes(1)
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(host.approvals).toEqual([
      expect.objectContaining({
        type: "sandbox_escalation",
        content: "touch /outside",
      }),
    ])
  })

  it("keeps the denied command inside the sandbox when escalation is declined", async () => {
    const runCommand = vi.fn()
    const host = createFakeHost({
      cwd: "/workspace",
      runCommand,
      async runSandboxedCommand() {
        return {
          stdout: "",
          stderr: "Operation not permitted",
          exitCode: 1,
          sandbox: "seatbelt",
          timedOut: false,
          denied: true,
        }
      },
      async showApprovalDialog() {
        return { approved: false }
      },
    })
    const context: ToolContext = {
      cwd: "/workspace",
      host,
      session: createFakeSession("/workspace"),
      config: createTestConfig({
        permissions: { autoApproveCommand: true },
      }),
      services: createNexusRunServices(),
      executionIdentityBase: {
        workspaceId: "workspace",
        sessionId: "session",
        turnId: "turn",
        runId: "run",
      },
      mode: "agent",
      signal: new AbortController().signal,
    }

    const result = await executeToolPipeline(
      {
        callId: "call",
        messageId: "message",
        partId: "part_call",
        toolName: "Bash",
        input: { command: "touch /outside" },
        origin: "native",
      },
      {
        tools: [bashTool],
        context,
        autoApproveActions: new Set(["execute"]),
        mode: "agent",
        mcpToolNames: new Set(),
        async hookRunner() {
          return []
        },
      },
    )

    expect(result.success).toBe(false)
    expect(result.output).toMatch(/not retried/i)
    expect(runCommand).not.toHaveBeenCalled()
  })
})
