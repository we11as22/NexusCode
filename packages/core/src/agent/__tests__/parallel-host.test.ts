import { describe, expect, it, vi } from "vitest"
import { createFakeHost, createFakeSession, createTestConfig } from "../../test/fakes.js"
import type { ISession, ToolContext } from "../../types.js"
import {
  createDelegatedHost,
  createTaskCreateBatchTool,
  ParallelAgentManager,
} from "../parallel.js"
import { createNexusRunServices } from "../run-services.js"

describe("delegated agent host boundary", () => {
  it("inherits the parent host permissions and operations with the delegated cwd", async () => {
    const runCommand = vi.fn(async () => ({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    }))
    const showApprovalDialog = vi.fn(async () => ({ approved: false }))
    const parent = createFakeHost({
      cwd: "/parent",
      runCommand,
      showApprovalDialog,
    })
    const events: string[] = []
    const delegated = createDelegatedHost(parent, "/child", (event) => {
      events.push(event.type)
    })

    expect(delegated.cwd).toBe("/child")
    await delegated.runCommand("pwd", "/child")
    await expect(delegated.showApprovalDialog({
      type: "execute",
      tool: "Bash",
      description: "run",
    })).resolves.toEqual({ approved: false })
    delegated.emit({ type: "error", error: "child error" })

    expect(runCommand).toHaveBeenCalledWith("pwd", "/child", undefined)
    expect(showApprovalDialog).toHaveBeenCalledOnce()
    expect(events).toEqual(["error"])
    expect(parent.events).toEqual([])
  })

  it("preserves optional host capabilities instead of replacing them with mocks", async () => {
    const requestMcpAuthentication = vi.fn(async () => ({
      success: true,
      message: "done",
    }))
    const queryLanguageServer = vi.fn(async () => ({
      operation: "hover" as const,
      summary: "symbol",
    }))
    const parent = createFakeHost({
      cwd: "/parent",
      requestMcpAuthentication,
      queryLanguageServer,
    })
    const delegated = createDelegatedHost(parent, "/child", () => {})

    await delegated.requestMcpAuthentication?.({ server: "docs" })
    await delegated.queryLanguageServer?.({ operation: "hover" })

    expect(requestMcpAuthentication).toHaveBeenCalledOnce()
    expect(queryLanguageServer).toHaveBeenCalledOnce()
  })
})

describe("delegated agent bounds", () => {
  it("rejects delegated working directories outside the parent workspace", async () => {
    const manager = new ParallelAgentManager()
    const host = createFakeHost({ cwd: "/workspace" })
    const services = createNexusRunServices({
      parallelAgentManager: manager,
    })
    const config = createTestConfig({
      parallelAgents: { maxParallel: 2, maxDepth: 2 },
    })

    await expect(manager.spawn(
      "escape task",
      "agent",
      config,
      "/outside",
      new AbortController().signal,
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { host, services },
    )).rejects.toThrow("escapes the parent workspace")
    expect(manager.activeCount).toBe(0)
  })

  it("enforces configured nesting depth before creating a child run", async () => {
    const manager = new ParallelAgentManager()
    const host = createFakeHost({ cwd: "/workspace" })
    const services = createNexusRunServices({
      parallelAgentManager: manager,
      subagentDepth: 0,
    })
    const config = createTestConfig({
      parallelAgents: { maxParallel: 2, maxDepth: 0 },
    })

    await expect(manager.spawn(
      "nested task",
      "agent",
      config,
      host.cwd,
      new AbortController().signal,
      2,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { host, services },
    )).rejects.toThrow("depth limit")
    expect(manager.activeCount).toBe(0)
  })

  it("fails nested delegation when the shared pool is saturated instead of deadlocking", async () => {
    const manager = new ParallelAgentManager()
    const host = createFakeHost({ cwd: "/workspace" })
    const services = createNexusRunServices({
      parallelAgentManager: manager,
      subagentDepth: 1,
    })
    const config = createTestConfig({
      parallelAgents: { maxParallel: 1, maxDepth: 2 },
    })
    const never = new Promise<never>(() => {})
    const internals = manager as unknown as {
      running: Map<string, Promise<never>>
    }
    internals.running.set("parent", never)

    await expect(manager.spawn(
      "grandchild task",
      "agent",
      config,
      host.cwd,
      new AbortController().signal,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { host, services },
    )).rejects.toThrow("fails fast")
  })

  it("delivers queued messages into a live child session by id or task name", () => {
    const manager = new ParallelAgentManager()
    const session = createFakeSession("/workspace")
    const internals = manager as unknown as {
      liveSessions: Map<string, ISession>
      aliases: Map<string, string>
    }
    internals.liveSessions.set("subagent_1", session)
    internals.aliases.set("reviewer", "subagent_1")

    expect(manager.deliverMessage("reviewer", "Check the auth path", "lead")).toBe(true)
    expect(manager.deliverMessage("missing", "ignored")).toBe(false)
    expect(session.messages.at(-1)).toMatchObject({
      role: "user",
      content: "[Message from lead]\nCheck the auth path",
    })
  })

  it("enforces the configured delegated batch size before spawning", async () => {
    const manager = new ParallelAgentManager()
    const config = createTestConfig({
      parallelAgents: { maxParallel: 2, maxDepth: 2, maxTasksPerCall: 2 },
    })
    const host = createFakeHost({ cwd: process.cwd() })
    const context: ToolContext = {
      cwd: host.cwd,
      host,
      session: createFakeSession(host.cwd),
      config,
      services: createNexusRunServices({ parallelAgentManager: manager }),
      signal: new AbortController().signal,
      mode: "agent",
    }
    const tool = createTaskCreateBatchTool(manager, config)

    const result = await tool.execute(
      {
        tasks: [
          { description: "one" },
          { description: "two" },
          { description: "three" },
        ],
      },
      context,
    )

    expect(result).toMatchObject({
      success: false,
      metadata: { taskCount: 3, maxTasksPerCall: 2 },
    })
    expect(manager.activeCount).toBe(0)
  })
})
