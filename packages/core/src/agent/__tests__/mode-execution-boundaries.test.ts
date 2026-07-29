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
import { askFollowupTool } from "../../tools/built-in/report-and-control.js"
import { ToolRegistry } from "../../tools/registry.js"
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

  it("does not advertise hidden compatibility fallbacks in the mode prompt", async () => {
    let capturedTools: string[] = []
    let capturedSystemPrompt = ""
    const bash: ToolDef = {
      name: "Bash",
      description: "Run an arbitrary command.",
      parameters: z.object({ command: z.string() }),
      async execute() {
        throw new Error("forbidden tool executed")
      },
    }
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: {
        tools?: Array<{ name: string }>
        systemPrompt?: string
      }) {
        capturedTools = (request.tools ?? []).map((tool) => tool.name)
        capturedSystemPrompt = request.systemPrompt ?? ""
        yield { type: "text_delta" as const, delta: "read-only" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient
    const cwd = process.cwd()
    const session = createFakeSession(cwd)
    session.addMessage({ role: "user", content: "inspect only" })

    await runAgentLoop({
      session,
      executionIdentity: {
        workspaceId: "test-workspace",
        sessionId: session.id,
        turnId: "test-turn",
        runId: "test-run",
      },
      client,
      host: createFakeHost({ cwd }),
      config: createTestConfig({
        memory: { sessionMemoryEnabled: false },
      }),
      services: createNexusRunServices({
        orchestrationRuntime: orchestrationRuntime as never,
      }),
      mode: "ask",
      tools: [bash],
      skills: [],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })

    expect(capturedTools).not.toContain("Bash")
    expect(capturedSystemPrompt).not.toContain(
      "Enabled tools for this turn: `Bash`.",
    )
    expect(capturedSystemPrompt).not.toContain(
      "## Bash / Terminal — Safe Usage",
    )
  })

  it("does not advertise questions when the client cannot answer them", async () => {
    let capturedTools: string[] = []
    let capturedSystemPrompt = ""
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: {
        tools?: Array<{ name: string }>
        systemPrompt?: string
      }) {
        capturedTools = (request.tools ?? []).map((tool) => tool.name)
        capturedSystemPrompt = request.systemPrompt ?? ""
        yield { type: "text_delta" as const, delta: "using an assumption" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient
    const cwd = process.cwd()
    const session = createFakeSession(cwd)
    session.addMessage({ role: "user", content: "continue non-interactively" })

    await runAgentLoop({
      session,
      executionIdentity: {
        workspaceId: "test-workspace",
        sessionId: session.id,
        turnId: "test-turn-no-questions",
        runId: "test-run-no-questions",
      },
      client,
      host: createFakeHost({
        cwd,
        capabilities: { interactiveQuestions: false },
      }),
      config: createTestConfig({
        memory: { sessionMemoryEnabled: false },
      }),
      services: createNexusRunServices({
        orchestrationRuntime: orchestrationRuntime as never,
      }),
      mode: "agent",
      tools: [askFollowupTool],
      skills: [],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })

    expect(capturedTools).not.toContain("AskFollowupQuestion")
    expect(capturedSystemPrompt).not.toContain("AskFollowupQuestion")
  })

  it("keeps the real latest user turn last in a continued conversation", async () => {
    let capturedMessages: Array<{ role: string; content: unknown }> = []
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: {
        messages: Array<{ role: string; content: unknown }>
      }) {
        capturedMessages = request.messages
        yield { type: "text_delta" as const, delta: "focused answer" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient
    const cwd = process.cwd()
    const session = createFakeSession(cwd)
    session.addMessage({ role: "user", content: "older request" })
    session.addMessage({ role: "assistant", content: "older response" })
    session.addMessage({ role: "user", content: "answer this latest question" })

    await runAgentLoop({
      session,
      executionIdentity: {
        workspaceId: "test-workspace",
        sessionId: session.id,
        turnId: "test-turn",
        runId: "test-run",
      },
      client,
      host: createFakeHost({ cwd }),
      config: createTestConfig({
        memory: { sessionMemoryEnabled: false },
      }),
      services: createNexusRunServices({
        orchestrationRuntime: orchestrationRuntime as never,
      }),
      mode: "ask",
      tools: [],
      skills: [],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })

    expect(capturedMessages.at(-1)).toEqual({
      role: "user",
      content: "answer this latest question",
    })
    expect(capturedMessages).not.toContainEqual(
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("[Context: New agent turn"),
      }),
    )
  })

  it("does not inject discovered skill bodies before an approved Skill call", async () => {
    let capturedSystemPrompt = ""
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: { systemPrompt?: string }) {
        capturedSystemPrompt = request.systemPrompt ?? ""
        yield { type: "text_delta" as const, delta: "answer" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient
    const cwd = process.cwd()
    const session = createFakeSession(cwd)
    session.addMessage({ role: "user", content: "answer without loading skills" })

    await runAgentLoop({
      session,
      executionIdentity: {
        workspaceId: "test-workspace",
        sessionId: session.id,
        turnId: "test-turn",
        runId: "test-run",
      },
      client,
      host: createFakeHost({ cwd }),
      config: createTestConfig({
        memory: { sessionMemoryEnabled: false },
      }),
      services: createNexusRunServices({
        orchestrationRuntime: orchestrationRuntime as never,
      }),
      mode: "ask",
      tools: [],
      skills: [{
        name: "dangerous-unloaded-skill",
        path: `${cwd}/SKILL.md`,
        summary: "not active",
        content: "UNAPPROVED_SKILL_BODY_MUST_NOT_APPEAR",
      }],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })

    expect(capturedSystemPrompt).not.toContain(
      "UNAPPROVED_SKILL_BODY_MUST_NOT_APPEAR",
    )
    expect(capturedSystemPrompt).not.toContain(
      "## Active Skills",
    )
  })

  it("re-projects an approved skill after compaction and resume", async () => {
    let capturedSystemPrompt = ""
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: { systemPrompt?: string }) {
        capturedSystemPrompt = request.systemPrompt ?? ""
        yield { type: "text_delta" as const, delta: "answer" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient
    const cwd = process.cwd()
    const session = createFakeSession(cwd)
    const priorAssistant = session.addMessage({
      role: "assistant",
      content: [],
    })
    session.addToolPart(priorAssistant.id, {
      type: "tool",
      id: "skill-call",
      tool: "Skill",
      status: "completed",
      input: { name: "safe-review" },
      output: "<skill_content>...</skill_content>",
      activatedSkillName: "safe-review",
    })
    session.addMessage({
      role: "assistant",
      content: "Earlier conversation summary.",
      summary: true,
    })
    session.addMessage({ role: "user", content: "continue after compaction" })

    await runAgentLoop({
      session,
      executionIdentity: {
        workspaceId: "test-workspace",
        sessionId: session.id,
        turnId: "test-turn",
        runId: "test-run",
      },
      client,
      host: createFakeHost({ cwd }),
      config: createTestConfig({
        memory: { sessionMemoryEnabled: false },
      }),
      services: createNexusRunServices({
        orchestrationRuntime: orchestrationRuntime as never,
      }),
      mode: "ask",
      tools: [],
      skills: [{
        name: "safe-review",
        path: `${cwd}/safe-review/SKILL.md`,
        summary: "review safely",
        content: "APPROVED_SKILL_BODY_SURVIVES_COMPACTION",
      }],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })

    expect(capturedSystemPrompt).toContain("## Active Skills")
    expect(capturedSystemPrompt).toContain(
      "APPROVED_SKILL_BODY_SURVIVES_COMPACTION",
    )
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
    expect(session.getMode()).toBe("plan")
  })

  it("rejects a forced synthetic PlanExit when no plan file was written", async () => {
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream() {
        yield { type: "text_delta" as const, delta: "I have a plan in mind." }
        yield { type: "finish" as const, finishReason: "stop" as const }
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
      mode: "plan",
      tools: [new ToolRegistry().get("PlanExit")!],
      skills: [],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })

    const forcedExit = host.events.find(
      (event) => event.type === "tool_end" && event.tool === "PlanExit",
    )
    expect(forcedExit).toMatchObject({
      type: "tool_end",
      tool: "PlanExit",
      success: false,
    })
    expect(
      session.messages.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "PlanExit" &&
              part.status === "completed",
          ),
      ),
    ).toBe(false)
  })

  it("does not treat a rejected explicit PlanExit as turn completion", async () => {
    let streamCalls = 0
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream() {
        streamCalls += 1
        if (streamCalls === 1) {
          yield {
            type: "tool_call" as const,
            toolCallId: "premature-plan-exit",
            toolName: "PlanExit",
            toolInput: { summary: "not materialized" },
          }
          yield {
            type: "finish" as const,
            finishReason: "tool_calls" as const,
          }
          return
        }
        yield {
          type: "text_delta" as const,
          delta: "I still need to materialize the plan.",
        }
        yield { type: "finish" as const, finishReason: "stop" as const }
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
      mode: "plan",
      tools: [new ToolRegistry().get("PlanExit")!],
      skills: [],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })

    expect(streamCalls).toBe(2)
    expect(
      host.events.filter(
        (event) =>
          event.type === "tool_end" &&
          event.tool === "PlanExit" &&
          !event.success,
      ),
    ).toHaveLength(2)
  })
})
