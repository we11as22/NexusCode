import { beforeEach, describe, expect, it, vi } from "vitest"

import type { SessionCompaction } from "../../session/compaction.js"
import { createCompaction } from "../../session/compaction.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { LLMClient } from "../../provider/types.js"
import type { ToolDef } from "../../types.js"
import { z } from "zod"
import { createNexusRunServices } from "../run-services.js"
import { runAgentLoop } from "../loop.js"

const runPluginHooks = vi.hoisted(() => vi.fn())
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

function client() {
  const stream = vi.fn(() => (async function* () {
    yield { type: "finish" as const, finishReason: "stop" as const }
  })())
  const generateStructured = vi.fn()
  return {
    value: {
      providerName: "test",
      modelId: "test-model",
      stream,
      generateStructured,
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient,
    stream,
    generateStructured,
  }
}

async function runBlockedLoop() {
  const cwd = process.cwd()
  const host = createFakeHost({ cwd })
  const session = createFakeSession(cwd)
  session.addMessage({ role: "user", content: "do work" })
  const llm = client()

  await runAgentLoop({
    session,
    client: llm.value,
    host,
    config: createTestConfig(),
    services: createNexusRunServices({
      orchestrationRuntime: orchestrationRuntime as never,
    }),
    mode: "agent",
    tools: [],
    skills: [],
    rulesContent: "project instructions",
    compaction: {} as SessionCompaction,
    signal: new AbortController().signal,
  })

  return { host, session, llm }
}

beforeEach(() => {
  runPluginHooks.mockReset()
})

describe("blocking lifecycle hooks", () => {
  it("stops before any provider call when user_prompt_submit blocks", async () => {
    runPluginHooks.mockImplementation(async (
      _cwd: string,
      _host: unknown,
      _config: unknown,
      event: string,
    ) => event === "user_prompt_submit"
      ? [{
          pluginName: "guard",
          hookEvent: event,
          output: "blocked",
          success: true,
          preventContinuation: true,
          stopReason: "Project policy rejected this prompt.",
        }]
      : [])

    const { host, llm } = await runBlockedLoop()

    expect(llm.stream).not.toHaveBeenCalled()
    expect(llm.generateStructured).not.toHaveBeenCalled()
    expect(host.events).toContainEqual({
      type: "error",
      error: "Project policy rejected this prompt.",
      fatal: false,
    })
    expect(host.events).toContainEqual({
      type: "session_saved",
      sessionId: expect.any(String),
    })
  })

  it("awaits instructions_loaded and honors its stop result before classification", async () => {
    runPluginHooks.mockImplementation(async (
      _cwd: string,
      _host: unknown,
      _config: unknown,
      event: string,
    ) => event === "instructions_loaded"
      ? [{
          pluginName: "instruction-guard",
          hookEvent: event,
          output: "invalid instructions",
          success: true,
          preventContinuation: true,
          stopReason: "Instruction policy rejected this run.",
        }]
      : [])

    const { host, llm } = await runBlockedLoop()

    expect(runPluginHooks.mock.calls.map((call) => call[3])).toEqual([
      "user_prompt_submit",
      "instructions_loaded",
    ])
    expect(llm.stream).not.toHaveBeenCalled()
    expect(llm.generateStructured).not.toHaveBeenCalled()
    expect(host.events).toContainEqual({
      type: "error",
      error: "Instruction policy rejected this run.",
      fatal: false,
    })
  })

  it("stops the provider stream before a later native tool after after_tool blocks", async () => {
    let executions = 0
    runPluginHooks.mockImplementation(async (
      _cwd: string,
      _host: unknown,
      _config: unknown,
      event: string,
    ) => event === "after_tool"
      ? [{
          pluginName: "guard",
          hookEvent: event,
          output: "stop",
          success: true,
          preventContinuation: true,
          stopReason: "Policy stopped the continuation.",
        }]
      : [])
    const tool: ToolDef = {
      name: "ExternalMutation",
      description: "test mutation",
      parameters: z.object({ ordinal: z.number() }),
      async execute() {
        executions += 1
        return { success: true, output: "done" }
      },
    }
    const llm = {
      providerName: "test",
      modelId: "test-model",
      async *stream() {
        yield {
          type: "tool_call" as const,
          toolCallId: "call-1",
          toolName: "ExternalMutation",
          toolInput: { ordinal: 1 },
        }
        yield {
          type: "tool_call" as const,
          toolCallId: "call-2",
          toolName: "ExternalMutation",
          toolInput: { ordinal: 2 },
        }
        yield {
          type: "finish" as const,
          finishReason: "tool_calls" as const,
        }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient
    const cwd = process.cwd()
    const session = createFakeSession(cwd)
    session.addMessage({ role: "user", content: "run one action" })

    await runAgentLoop({
      session,
      client: llm,
      host: createFakeHost({ cwd }),
      config: createTestConfig(),
      services: createNexusRunServices({
        orchestrationRuntime: orchestrationRuntime as never,
      }),
      mode: "agent",
      tools: [tool],
      skills: [],
      rulesContent: "",
      compaction: createCompaction(),
      signal: new AbortController().signal,
    })

    expect(executions).toBe(1)
  })
})
