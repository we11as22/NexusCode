import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import type { LLMClient } from "../../provider/types.js"
import { createCompaction } from "../../session/compaction.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import {
  enterPlanModeTool,
  taskCreateTool,
} from "../../tools/built-in/orchestration-tools.js"
import type { ToolContext, ToolDef } from "../../types.js"
import {
  restrictDelegatedMode,
} from "../parallel.js"
import { runAgentLoop } from "../loop.js"
import { createNexusRunServices } from "../run-services.js"

const runPluginHooks = vi.hoisted(() => vi.fn(async () => []))
const orchestrationRuntime = vi.hoisted(() => ({
  listTeams: async () => [],
  listMemories: async () => [],
  listTeamNamesForSession: async () => [],
  recordMemoryAccess: async () => undefined,
  listBackgroundTasks: async () => [],
}))

vi.mock("../../plugins/runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../plugins/runtime.js")>()
  return {
    ...actual,
    runPluginHooks,
  }
})

function toolContext(mode: ToolContext["mode"]): ToolContext {
  const cwd = process.cwd()
  return {
    cwd,
    host: createFakeHost({ cwd }),
    session: createFakeSession(cwd),
    config: createTestConfig(),
    services: createNexusRunServices({
      orchestrationRuntime: orchestrationRuntime as never,
    }),
    mode,
    signal: new AbortController().signal,
  }
}

describe("runtime mode boundaries", () => {
  it.each([
    {
      mode: "ask" as const,
      input: {
        kind: "shell" as const,
        subject: "Run command",
        description: "must not execute",
        command: "echo unsafe",
      },
    },
    {
      mode: "plan" as const,
      input: {
        kind: "agent" as const,
        subject: "Isolated agent",
        description: "must not create worktree",
        isolation: "worktree" as const,
      },
    },
    {
      mode: "ask" as const,
      input: {
        kind: "tracking" as const,
        subject: "Mutate task state",
        description: "must stay read-only",
      },
    },
  ])("blocks TaskCreate side effects in $mode mode", async ({ mode, input }) => {
    const context = toolContext(mode)
    const runCommand = vi.spyOn(context.host, "runCommand")

    const result = await taskCreateTool.execute(input, context)

    expect(result.success).toBe(false)
    expect(result.output).toMatch(/mode/i)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it("clamps resumed agent/debug work to ask under a restrictive parent", () => {
    expect(restrictDelegatedMode("ask", "agent")).toBe("ask")
    expect(restrictDelegatedMode("plan", "debug")).toBe("ask")
    expect(restrictDelegatedMode("review", "agent")).toBe("ask")
    expect(restrictDelegatedMode("agent", "debug")).toBe("debug")
  })

  it("ends the current response immediately after EnterPlanMode", async () => {
    let bashExecutions = 0
    const bash: ToolDef = {
      name: "Bash",
      description: "test command",
      parameters: z.object({ command: z.string() }),
      async execute() {
        bashExecutions += 1
        return { success: true, output: "unsafe" }
      },
    }
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream() {
        yield {
          type: "tool_call" as const,
          toolCallId: "mode-change",
          toolName: "EnterPlanMode",
          toolInput: { reason: "design first" },
        }
        yield {
          type: "tool_call" as const,
          toolCallId: "must-not-run",
          toolName: "Bash",
          toolInput: { command: "echo unsafe" },
        }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient
    const cwd = process.cwd()
    const host = createFakeHost({ cwd })
    const session = createFakeSession(cwd)
    session.addMessage({ role: "user", content: "plan this task" })

    await runAgentLoop({
      session,
      executionIdentity: {
        workspaceId: "test-workspace",
        sessionId: session.id,
        turnId: "test-turn",
        runId: "test-run",
      },
      client,
      host,
      config: createTestConfig(),
      services: createNexusRunServices({
        orchestrationRuntime: orchestrationRuntime as never,
      }),
      mode: "agent",
      tools: [enterPlanModeTool, bash],
      skills: [],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })

    expect(bashExecutions).toBe(0)
    const modeToolEnd = host.events.find(
      (event) => event.type === "tool_end" &&
        event.tool === "EnterPlanMode",
    )
    expect(modeToolEnd).toMatchObject({
      type: "tool_end",
      success: true,
      metadata: {
        modeChange: {
          success: true,
          mode: "plan",
        },
      },
    })
    expect(host.events.some(
      (event) => event.type === "tool_start" && event.tool === "Bash",
    )).toBe(false)
  })
})
