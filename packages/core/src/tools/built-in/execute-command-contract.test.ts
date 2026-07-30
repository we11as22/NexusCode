import { describe, expect, it, vi } from "vitest"
import type { ToolContext } from "../../types.js"
import { bashTool } from "./execute-command.js"
import { powerShellTool } from "./orchestration-tools.js"

describe("Bash tool execution contract", () => {
  it("does not advertise a sandbox override when the host has no sandbox port", () => {
    const parsed = bashTool.parameters.safeParse({
      command: "printf safe",
      dangerouslyDisableSandbox: true,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("dangerouslyDisableSandbox")
    }
    expect(bashTool.description.toLowerCase()).not.toContain(
      "override sandbox",
    )
  })

  it("fails closed instead of falling back to the legacy host command port", async () => {
    const runCommand = vi.fn()
    const result = await bashTool.execute(
      { command: "printf safe" },
      {
        cwd: "/workspace",
        host: { runCommand } as unknown as ToolContext["host"],
        signal: new AbortController().signal,
      } as ToolContext,
    )

    expect(result.success).toBe(false)
    expect(result.output).toMatch(/sandbox.+unavailable/i)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it("sends an immutable workspace-write request to the sandbox host port", async () => {
    const runCommand = vi.fn()
    const runSandboxedCommand = vi.fn().mockResolvedValue({
      stdout: "safe",
      stderr: "",
      exitCode: 0,
      sandbox: "seatbelt",
      timedOut: false,
      denied: false,
    })
    const result = await bashTool.execute(
      { command: "printf safe", timeout: 3210 },
      {
        cwd: "/workspace",
        host: {
          cwd: "/workspace",
          runCommand,
          runSandboxedCommand,
        } as unknown as ToolContext["host"],
        executionIdentity: {
          workspaceId: "workspace",
          sessionId: "session",
          turnId: "turn",
          runId: "run",
          messageId: "message",
          partId: "part",
          toolCallId: "tool-call",
        },
        signal: new AbortController().signal,
      } as ToolContext,
    )

    expect(result.success).toBe(true)
    expect(runSandboxedCommand).toHaveBeenCalledWith(
      {
        executionId: "run:message:part:tool-call",
        command: "printf safe",
        cwd: "/workspace",
        workspaceRoots: ["/workspace"],
        profile: "workspace-write",
        network: "restricted",
        timeoutMs: 3210,
      },
      expect.any(AbortSignal),
    )
    expect(runCommand).not.toHaveBeenCalled()
  })
})

describe("PowerShell tool execution contract", () => {
  it("fails closed when the host has no sandbox port", async () => {
    const runCommand = vi.fn()
    const result = await powerShellTool.execute(
      { command: "Write-Output safe" },
      {
        cwd: "C:\\workspace",
        host: { runCommand } as unknown as ToolContext["host"],
        signal: new AbortController().signal,
      } as ToolContext,
    )

    expect(result.success).toBe(false)
    expect(result.output).toMatch(/sandbox.+unavailable/i)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it("uses the same restricted sandbox port as Bash", async () => {
    const runCommand = vi.fn()
    const runSandboxedCommand = vi.fn().mockResolvedValue({
      stdout: "safe",
      stderr: "",
      exitCode: 0,
      sandbox: "windows-restricted-token",
      timedOut: false,
      denied: false,
    })
    const result = await powerShellTool.execute(
      { command: "Write-Output safe", timeout: 4321 },
      {
        cwd: "C:\\workspace",
        host: {
          cwd: "C:\\workspace",
          runCommand,
          runSandboxedCommand,
        } as unknown as ToolContext["host"],
        executionIdentity: {
          workspaceId: "workspace",
          sessionId: "session",
          turnId: "turn",
          runId: "run",
          messageId: "message",
          partId: "part",
          toolCallId: "tool-call",
        },
        signal: new AbortController().signal,
      } as ToolContext,
    )

    expect(result.success).toBe(true)
    expect(runSandboxedCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "run:message:part:tool-call:powershell-0",
        cwd: "C:\\workspace",
        workspaceRoots: ["C:\\workspace"],
        profile: "workspace-write",
        network: "restricted",
        timeoutMs: 4321,
      }),
      expect.any(AbortSignal),
    )
    expect(runCommand).not.toHaveBeenCalled()
  })
})
