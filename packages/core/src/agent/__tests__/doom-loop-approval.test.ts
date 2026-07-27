import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import type { LLMClient } from "../../provider/types.js"
import { createCompaction } from "../../session/compaction.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { ToolDef } from "../../types.js"
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

beforeEach(() => {
  runPluginHooks.mockClear()
})

describe("doom-loop approval coordination", () => {
  it("uses the host approval channel on non-TTY surfaces before continuing", async () => {
    const cwd = process.cwd()
    const host = createFakeHost({
      cwd,
      async showApprovalDialog() {
        return { approved: true }
      },
    })
    const session = createFakeSession(cwd)
    session.addMessage({ role: "user", content: "recover from failures" })
    for (let index = 0; index < 3; index += 1) {
      const message = session.addMessage({
        role: "assistant",
        content: "",
      })
      session.addToolPart(message.id, {
        type: "tool",
        id: `prior-${index}`,
        tool: "RetryTool",
        status: "error",
        input: { value: "same" },
        output: "failed",
        timeStart: index,
        timeEnd: index,
      })
    }

    let executions = 0
    const tool: ToolDef = {
      name: "RetryTool",
      description: "retry a harmless fake operation",
      parameters: z.object({ value: z.string() }),
      async execute() {
        executions += 1
        return { success: true, output: "recovered" }
      },
    }
    let providerCalls = 0
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream() {
        providerCalls += 1
        if (providerCalls === 1) {
          yield {
            type: "tool_call" as const,
            toolCallId: "retry-current",
            toolName: "RetryTool",
            toolInput: { value: "same" },
          }
          yield {
            type: "finish" as const,
            finishReason: "tool_calls" as const,
          }
          return
        }
        yield { type: "text_delta" as const, delta: "done" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    await runAgentLoop({
      session,
      client,
      host,
      config: createTestConfig({
        memory: { sessionMemoryEnabled: false },
      }),
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

    expect(host.events).toContainEqual({
      type: "doom_loop_detected",
      tool: "RetryTool",
    })
    expect(host.events).toContainEqual(expect.objectContaining({
      type: "tool_approval_needed",
      partId: "part_retry-current",
      action: expect.objectContaining({
        type: "doom_loop",
        tool: "RetryTool",
      }),
    }))
    expect(host.approvals).toHaveLength(1)
    expect(executions).toBe(1)
  })
})
