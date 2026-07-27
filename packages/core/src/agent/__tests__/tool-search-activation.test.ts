import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import type {
  LLMClient,
  StreamOptions,
} from "../../provider/types.js"
import { createCompaction } from "../../session/compaction.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import { toolSearchTool } from "../../tools/built-in/orchestration-tools.js"
import type {
  MessagePart,
  ToolDef,
  ToolPart,
} from "../../types.js"
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

function toolNames(request: StreamOptions): string[] {
  return (request.tools ?? []).map((tool) => tool.name)
}

function lastToolOutput(
  session: ReturnType<typeof createFakeSession>,
  toolName: string,
): string | undefined {
  for (let messageIndex = session.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = session.messages[messageIndex]
    if (!message || !Array.isArray(message.content)) continue
    const parts = message.content as MessagePart[]
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]
      if (part?.type === "tool" && (part as ToolPart).tool === toolName) {
        return (part as ToolPart).output
      }
    }
  }
  return undefined
}

async function runWithTools(options: {
  tools: ToolDef[]
  client: LLMClient
  mode?: "agent" | "ask"
  config?: ReturnType<typeof createTestConfig>
}) {
  const cwd = process.cwd()
  const session = createFakeSession(cwd)
  session.addMessage({ role: "user", content: "find and use the requested capability" })
  await runAgentLoop({
    session,
    client: options.client,
    host: createFakeHost({
      cwd,
      async showApprovalDialog() {
        return { approved: true }
      },
    }),
    config: options.config ?? createTestConfig({
      memory: { sessionMemoryEnabled: false },
    }),
    services: createNexusRunServices({
      orchestrationRuntime: orchestrationRuntime as never,
    }),
    mode: options.mode ?? "agent",
    tools: options.tools,
    skills: [],
    rulesContent: "",
    compaction: createCompaction(),
    signal: new AbortController().signal,
  })
  return session
}

beforeEach(() => {
  runPluginHooks.mockClear()
})

describe("ToolSearch run-local activation", () => {
  it("adds a deferred tool to the next provider manifest before executing it", async () => {
    const requests: string[][] = []
    let deferredExecutions = 0
    const deferredTool: ToolDef = {
      name: "DeferredWidget",
      description: "Inspect a deferred widget by id.",
      parameters: z.object({ id: z.string() }),
      readOnly: true,
      shouldDefer: true,
      async execute({ id }) {
        deferredExecutions += 1
        return { success: true, output: `widget:${id}` }
      },
    }
    let providerCall = 0
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(toolNames(request))
        providerCall += 1
        if (providerCall === 1) {
          yield {
            type: "tool_call" as const,
            toolCallId: "search-deferred",
            toolName: "ToolSearch",
            toolInput: { query: "select:DeferredWidget" },
          }
          yield { type: "finish" as const, finishReason: "tool_calls" as const }
          return
        }
        if (providerCall === 2) {
          yield {
            type: "tool_call" as const,
            toolCallId: "use-deferred",
            toolName: "DeferredWidget",
            toolInput: { id: "42" },
          }
          yield { type: "finish" as const, finishReason: "tool_calls" as const }
          return
        }
        yield { type: "text_delta" as const, delta: "done" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      async generateStructured() {
        return { selected: [] }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    await runWithTools({
      tools: [toolSearchTool, deferredTool],
      client,
      config: createTestConfig({
        memory: { sessionMemoryEnabled: false },
        tools: { deferredLoadingMode: "always" },
      }),
    })

    expect(requests[0]).toContain("ToolSearch")
    expect(requests[0]).not.toContain("DeferredWidget")
    expect(requests[1]).toContain("DeferredWidget")
    expect(deferredExecutions).toBe(1)
  })

  it("does not execute a newly discovered schema in the same provider response", async () => {
    const requests: string[][] = []
    let executions = 0
    const deferredTool: ToolDef = {
      name: "DeferredBoundary",
      description: "Read a deferred boundary value.",
      parameters: z.object({ value: z.string() }),
      readOnly: true,
      shouldDefer: true,
      async execute() {
        executions += 1
        return { success: true, output: "executed" }
      },
    }
    let providerCall = 0
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(toolNames(request))
        providerCall += 1
        if (providerCall === 1) {
          yield {
            type: "tool_call" as const,
            toolCallId: "discover-boundary",
            toolName: "ToolSearch",
            toolInput: { query: "select:DeferredBoundary" },
          }
          yield {
            type: "tool_call" as const,
            toolCallId: "premature-boundary",
            toolName: "DeferredBoundary",
            toolInput: { value: "too early" },
          }
          yield { type: "finish" as const, finishReason: "tool_calls" as const }
          return
        }
        if (providerCall === 2) {
          yield {
            type: "tool_call" as const,
            toolCallId: "valid-boundary",
            toolName: "DeferredBoundary",
            toolInput: { value: "now active" },
          }
          yield { type: "finish" as const, finishReason: "tool_calls" as const }
          return
        }
        yield { type: "text_delta" as const, delta: "done" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      async generateStructured() {
        return { selected: [] }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    await runWithTools({
      tools: [toolSearchTool, deferredTool],
      client,
      config: createTestConfig({
        memory: { sessionMemoryEnabled: false },
        tools: {
          deferredLoadingMode: "always",
          parallelReads: true,
        },
      }),
    })

    expect(requests[0]).not.toContain("DeferredBoundary")
    expect(requests[1]).toContain("DeferredBoundary")
    expect(executions).toBe(1)
  })

  it("restores mode-authorized discoveries from a persisted ToolSearch result", async () => {
    const cwd = process.cwd()
    const session = createFakeSession(cwd)
    const priorAssistant = session.addMessage({
      role: "assistant",
      content: "",
    })
    session.addToolPart(priorAssistant.id, {
      type: "tool",
      id: "persisted-search",
      tool: "ToolSearch",
      status: "completed",
      input: { query: "select:DeferredResume" },
      output: "DeferredResume",
      activatedToolNames: ["DeferredResume", "ForbiddenOldName"],
    })
    session.addMessage({ role: "user", content: "continue after restart" })
    const requests: string[][] = []
    const deferredTool: ToolDef = {
      name: "DeferredResume",
      description: "Inspect a value after session resume.",
      parameters: z.object({}),
      readOnly: true,
      shouldDefer: true,
      async execute() {
        return { success: true, output: "available" }
      },
    }
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(toolNames(request))
        yield { type: "text_delta" as const, delta: "resumed" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      async generateStructured() {
        return { selected: [] }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    await runAgentLoop({
      session,
      client,
      host: createFakeHost({ cwd }),
      config: createTestConfig({
        memory: { sessionMemoryEnabled: false },
        tools: { deferredLoadingMode: "always" },
      }),
      services: createNexusRunServices({
        orchestrationRuntime: orchestrationRuntime as never,
      }),
      mode: "agent",
      tools: [toolSearchTool, deferredTool],
      skills: [],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })

    expect(requests[0]).toContain("DeferredResume")
    expect(requests[0]).not.toContain("ForbiddenOldName")
  })

  it("uses deterministic MCP discovery without the legacy LLM classifier", async () => {
    const requests: string[][] = []
    let hiddenExecutions = 0
    const selectedTool: ToolDef = {
      name: "alpha__lookup",
      description: "Look up alpha records.",
      parameters: z.object({}),
      readOnly: true,
      shouldDefer: true,
      integration: {
        kind: "mcp",
        serverName: "alpha",
        originalName: "lookup",
      },
      async execute() {
        return { success: true, output: "alpha" }
      },
    }
    const hiddenTool: ToolDef = {
      name: "omega__inspect",
      description: "Inspect an omega record.",
      parameters: z.object({ id: z.string() }),
      readOnly: true,
      shouldDefer: true,
      integration: {
        kind: "mcp",
        serverName: "omega",
        originalName: "inspect",
      },
      async execute({ id }) {
        hiddenExecutions += 1
        return { success: true, output: `omega:${id}` }
      },
    }
    let providerCall = 0
    const generateStructured = vi.fn(async () => {
      throw new Error("legacy classifier must not run")
    })
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(toolNames(request))
        providerCall += 1
        if (providerCall === 1) {
          yield {
            type: "tool_call" as const,
            toolCallId: "search-classified-out",
            toolName: "ToolSearch",
            toolInput: { query: "omega inspect" },
          }
          yield { type: "finish" as const, finishReason: "tool_calls" as const }
          return
        }
        if (providerCall === 2) {
          yield {
            type: "tool_call" as const,
            toolCallId: "use-classified-out",
            toolName: "omega__inspect",
            toolInput: { id: "7" },
          }
          yield { type: "finish" as const, finishReason: "tool_calls" as const }
          return
        }
        yield { type: "text_delta" as const, delta: "done" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      generateStructured,
      supportsStructuredOutput: () => true,
      getModel: () => ({}),
    } as unknown as LLMClient

    await runWithTools({
      tools: [toolSearchTool, selectedTool, hiddenTool],
      client,
      config: createTestConfig({
        memory: { sessionMemoryEnabled: false },
        tools: {
          classifyToolsEnabled: true,
          classifyThreshold: 1,
          deferredLoadingMode: "always",
        },
      }),
    })

    expect(generateStructured).not.toHaveBeenCalled()
    expect(requests[0]).not.toContain("alpha__lookup")
    expect(requests[0]).not.toContain("omega__inspect")
    expect(requests[1]).toContain("omega__inspect")
    expect(hiddenExecutions).toBe(1)
  })

  it("never exposes or activates a tool forbidden by the current mode", async () => {
    const requests: string[][] = []
    const bash: ToolDef = {
      name: "Bash",
      description: "Run an arbitrary command.",
      parameters: z.object({ command: z.string() }),
      async execute() {
        throw new Error("forbidden tool executed")
      },
    }
    let providerCall = 0
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(toolNames(request))
        providerCall += 1
        if (providerCall === 1) {
          yield {
            type: "tool_call" as const,
            toolCallId: "search-forbidden",
            toolName: "ToolSearch",
            toolInput: { query: "Bash" },
          }
          yield { type: "finish" as const, finishReason: "tool_calls" as const }
          return
        }
        yield { type: "text_delta" as const, delta: "not available" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      async generateStructured() {
        return { selected: [] }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    const session = await runWithTools({
      tools: [toolSearchTool, bash],
      client,
      mode: "ask",
    })

    expect(requests.every((names) => !names.includes("Bash"))).toBe(true)
    expect(lastToolOutput(session, "ToolSearch")).toContain(
      "No tools matched query: Bash",
    )
  })
})
