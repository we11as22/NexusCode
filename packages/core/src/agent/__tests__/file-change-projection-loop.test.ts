import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import type { LLMClient } from "../../provider/types.js"
import { createCompaction } from "../../session/compaction.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type {
  AgentEvent,
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

beforeEach(() => {
  runPluginHooks.mockClear()
})

function completedToolPart(
  messages: readonly { content: string | MessagePart[] }[],
  tool: string,
): ToolPart {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    const match = message.content.find(
      (part): part is ToolPart =>
        part.type === "tool" &&
        part.tool === tool &&
        part.status === "completed",
    )
    if (match) return match
  }
  throw new Error(`Completed ${tool} part not found`)
}

function completedToolEvent(events: readonly AgentEvent[], tool: string) {
  const event = events.find(
    (candidate): candidate is Extract<AgentEvent, { type: "tool_end" }> =>
      candidate.type === "tool_end" &&
      candidate.tool === tool &&
      candidate.success,
  )
  if (!event) throw new Error(`Completed ${tool} event not found`)
  return event
}

async function runToolTurn(input: {
  tool: ToolDef
  firstResponse:
    | {
        origin: "native"
        toolCallId: string
        toolName: string
        toolInput: Record<string, unknown>
      }
    | {
        origin: "textual"
        text: string
      }
}) {
  let call = 0
  const client = {
    providerName: "test",
    modelId: "test-model",
    async *stream() {
      call += 1
      if (call === 1) {
        if (input.firstResponse.origin === "native") {
          yield {
            type: "tool_call" as const,
            toolCallId: input.firstResponse.toolCallId,
            toolName: input.firstResponse.toolName,
            toolInput: input.firstResponse.toolInput,
          }
          yield {
            type: "finish" as const,
            finishReason: "tool_calls" as const,
          }
          return
        }
        yield {
          type: "text_delta" as const,
          delta: input.firstResponse.text,
        }
        yield { type: "finish" as const, finishReason: "stop" as const }
        return
      }
      yield { type: "text_delta" as const, delta: "done" }
      yield { type: "finish" as const, finishReason: "stop" as const }
    },
    supportsStructuredOutput: () => false,
    getModel: () => ({}),
  } as unknown as LLMClient

  const cwd = process.cwd()
  const host = createFakeHost({
    cwd,
    async showApprovalDialog() {
      return { approved: true }
    },
  })
  const session = createFakeSession(cwd)
  session.addMessage({ role: "user", content: "change the fixture" })
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
    config: createTestConfig({
      memory: { sessionMemoryEnabled: false },
    }),
    services: createNexusRunServices({
      orchestrationRuntime: orchestrationRuntime as never,
    }),
    mode: "agent",
    tools: [input.tool],
    skills: [],
    rulesContent: "",
    compaction: createCompaction(),
    signal: new AbortController().signal,
  })
  return { session, host }
}

describe("agent-loop file change projection", () => {
  it("stores the same exact Write preview that it emits for a native tool call", async () => {
    const tool: ToolDef = {
      name: "Write",
      description: "Write a controlled fixture",
      parameters: z.object({
        file_path: z.string(),
        content: z.string(),
      }),
      requiresApproval: false,
      async execute() {
        return {
          success: true,
          output: "Successfully wrote fixture.txt (2 lines)",
          metadata: {
            addedLines: 2,
            removedLines: 0,
            writtenContent: "ALPHA\nBETA\n",
            diffHunks: [
              { type: "add", lineNum: 1, line: "ALPHA" },
              { type: "add", lineNum: 2, line: "BETA" },
            ],
          },
        }
      },
    }

    const { session, host } = await runToolTurn({
      tool,
      firstResponse: {
        origin: "native",
        toolCallId: "write-1",
        toolName: "Write",
        toolInput: {
          file_path: "fixture.txt",
          content: "ALPHA\nBETA\n",
        },
      },
    })

    const part = completedToolPart(session.messages, "Write")
    const event = completedToolEvent(host.events, "Write")
    expect(part).toMatchObject({
      path: "fixture.txt",
      diffStats: { added: 2, removed: 0 },
      diffHunks: [
        { type: "add", lineNum: 1, line: "ALPHA" },
        { type: "add", lineNum: 2, line: "BETA" },
      ],
    })
    expect(event).toMatchObject({
      path: part.path,
      diffStats: part.diffStats,
      diffHunks: part.diffHunks,
    })
    expect(part).not.toHaveProperty("writtenContent")
  })

  it("stores the same exact Edit preview that it emits for a textual tool call", async () => {
    const tool: ToolDef = {
      name: "Edit",
      description: "Edit a controlled fixture",
      parameters: z.object({
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      requiresApproval: false,
      async execute() {
        return {
          success: true,
          output:
            "Successfully updated fixture.txt\n\n" +
            "<updated_content>\nALPHA\nGAMMA\n</updated_content>",
          metadata: {
            addedLines: 1,
            removedLines: 1,
            writtenContent: "ALPHA\nGAMMA\n",
            diffHunks: [
              { type: "remove", lineNum: 2, line: "BETA" },
              { type: "add", lineNum: 2, line: "GAMMA" },
            ],
            appliedReplacements: [
              { oldSnippet: "BETA", newSnippet: "GAMMA" },
            ],
          },
        }
      },
    }

    const { session, host } = await runToolTurn({
      tool,
      firstResponse: {
        origin: "textual",
        text:
          "<tool_call><function=Edit>" +
          "<parameter=file_path>fixture.txt</parameter>" +
          "<parameter=old_string>BETA</parameter>" +
          "<parameter=new_string>GAMMA</parameter>" +
          "</function></tool_call>",
      },
    })

    const part = completedToolPart(session.messages, "Edit")
    const event = completedToolEvent(host.events, "Edit")
    expect(part).toMatchObject({
      path: "fixture.txt",
      diffStats: { added: 1, removed: 1 },
      diffHunks: [
        { type: "remove", lineNum: 2, line: "BETA" },
        { type: "add", lineNum: 2, line: "GAMMA" },
      ],
      appliedReplacements: [
        { oldSnippet: "BETA", newSnippet: "GAMMA" },
      ],
    })
    expect(event).toMatchObject({
      path: part.path,
      diffStats: part.diffStats,
      diffHunks: part.diffHunks,
      appliedReplacements: part.appliedReplacements,
    })
    expect(part).not.toHaveProperty("writtenContent")
  })
})
