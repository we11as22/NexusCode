import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { createFakeHost, createFakeSession, createTestConfig } from "../../test/fakes.js"
import type { ISession, ToolContext } from "../../types.js"
import { ToolRegistry } from "../../tools/registry.js"
import {
  buildDelegatedRulesContent,
  createDelegatedHost,
  createTaskCreateBatchTool,
  ParallelAgentManager,
  registerInheritedRunTools,
} from "../parallel.js"
import { createNexusRunServices } from "../run-services.js"
import { OrchestrationRuntime } from "../../orchestration/runtime.js"

describe("delegated agent host boundary", () => {
  it("keeps the delegated role in the system instruction bundle across resume", () => {
    const rules = buildDelegatedRulesContent(
      "Project rules.",
      {
        agentType: "SecurityReview",
        systemPrompt: "Inspect trust boundaries and report evidence.",
      },
    )

    expect(rules).toContain("Project rules.")
    expect(rules).toContain("Delegated agent contract")
    expect(rules).toContain("SecurityReview")
    expect(rules).toContain("Inspect trust boundaries and report evidence.")
    expect(rules).toContain("Do not address the end user directly")
  })

  it("inherits only the root turn MCP snapshot, never the mutable live client catalog", () => {
    const allowed = {
      name: "allowed__read",
      description: "allowed",
      parameters: z.object({}),
      async execute() {
        return { success: true, output: "allowed" }
      },
    }
    const services = createNexusRunServices({
      mcpClient: {
        getTools: () => [{
          ...allowed,
          name: "other_workspace__secret",
        }],
      } as never,
      mcpToolSnapshot: Object.freeze([allowed]),
    })
    const registry = new ToolRegistry()

    registerInheritedRunTools(registry, services)

    const names = registry.getAll().map((tool) => tool.name)
    expect(names).toContain("allowed__read")
    expect(names).not.toContain("other_workspace__secret")
  })

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
  it("makes shutdown terminal and idempotent", async () => {
    const manager = new ParallelAgentManager()

    const first = manager.shutdown()
    const second = manager.shutdown()

    expect(second).toBe(first)
    await first
    await expect(manager.spawn(
      "late task",
      "agent",
      createTestConfig(),
      process.cwd(),
      new AbortController().signal,
      1,
    )).rejects.toThrow(/shutting down/i)
  })

  it("rejects a spawn when shutdown wins an asynchronous admission race", async () => {
    const manager = new ParallelAgentManager()
    const host = createFakeHost({ cwd: process.cwd() })
    const services = createNexusRunServices({
      parallelAgentManager: manager,
      subagentDepth: 0,
    })
    const config = createTestConfig({
      parallelAgents: { maxParallel: 1, maxDepth: 0 },
    })

    const spawning = manager.spawn(
      "racing task",
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
      { host, services, ownerSessionId: "session_owner" },
    )
    const shuttingDown = manager.shutdown()

    await expect(spawning).rejects.toThrow(/shutting down/i)
    await shuttingDown
    expect(manager.activeCount).toBe(0)
  })

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
      { host, services, ownerSessionId: "session_owner" },
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
      { host, services, ownerSessionId: "session_owner" },
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
      { host, services, ownerSessionId: "session_owner" },
    )).rejects.toThrow("fails fast")
  })

  it("queues by exact owned id or unique persisted task name without mutating a live session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexus-agent-message-"))
    const cwd = path.join(root, "workspace")
    await mkdir(cwd)
    try {
      const runtime = new OrchestrationRuntime(cwd, {
        homeDir: path.join(root, ".nexus"),
        reconcileStaleRuns: false,
      })
      await runtime.registerBackgroundTask({
        id: "subagent_1",
        kind: "subagent",
        description: "review",
        status: "running",
        sessionId: "session_owner",
        metadata: { name: "reviewer" },
      })
      await runtime.registerBackgroundTask({
        id: "subagent_foreign",
        kind: "subagent",
        description: "foreign review",
        status: "running",
        sessionId: "session_other",
        metadata: { name: "reviewer" },
      })
      const manager = new ParallelAgentManager(runtime)
      const liveSession = createFakeSession(cwd)
      const internals = manager as unknown as {
        liveSessions?: Map<string, ISession>
      }
      internals.liveSessions = new Map([["subagent_1", liveSession]])

      await expect(manager.queueMessage({
        target: "reviewer",
        message: "Check the auth path",
        from: "lead",
        ownerSessionId: "session_owner",
      })).resolves.toMatchObject({
        targetAgentId: "subagent_1",
        record: {
          ownerSessionId: "session_owner",
          targetAgentId: "subagent_1",
          message: "Check the auth path",
        },
      })
      await expect(manager.queueMessage({
        target: "subagent_1",
        message: "Do not leak this",
        from: "other",
        ownerSessionId: "session_other",
      })).rejects.toThrow(/not found/i)
      await expect(manager.queueMessage({
        target: "missing",
        message: "ignored",
        from: "lead",
        ownerSessionId: "session_owner",
      })).rejects.toThrow(/not found/i)

      expect(liveSession.messages).toEqual([])
      await expect(runtime.listPendingAgentMessages({
        ownerSessionId: "session_owner",
        targetAgentId: "subagent_1",
      })).resolves.toMatchObject([
        { from: "lead", message: "Check the auth path" },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("does not expose or stop a live delegated run from another session", () => {
    const manager = new ParallelAgentManager()
    const controller = new AbortController()
    const internals = manager as unknown as {
      sessions: Map<string, string>
      statusById: Map<string, "running">
      outputById: Map<string, string>
      controllers: Map<string, AbortController>
      ownerSessionById: Map<string, string>
    }
    internals.sessions.set("subagent_1", "worker_session")
    internals.statusById.set("subagent_1", "running")
    internals.outputById.set("subagent_1", "private output")
    internals.controllers.set("subagent_1", controller)
    internals.ownerSessionById.set("subagent_1", "session_owner")

    expect(manager.getSnapshot("subagent_1", "session_other")).toBeNull()
    expect(manager.stop("subagent_1", "session_other")).toBe(false)
    expect(controller.signal.aborted).toBe(false)

    expect(manager.getSnapshot("subagent_1", "session_owner")).toMatchObject({
      subagentId: "subagent_1",
      sessionId: "worker_session",
      output: "private output",
    })
    expect(manager.stop("subagent_1", "session_owner")).toBe(true)
    expect(controller.signal.aborted).toBe(true)
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
