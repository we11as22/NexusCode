import { beforeEach, describe, expect, it, vi } from "vitest"

import type { NexusRunServices } from "../run-services.js"
import type {
  CompactionResult,
  SessionCompaction,
} from "../../session/compaction.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type { LLMClient } from "../../provider/types.js"
import { condenseTool } from "../../tools/built-in/context-tools.js"
import type { ToolDef } from "../../types.js"
import { runAgentLoop } from "../loop.js"

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

function services(): NexusRunServices {
  return {
    orchestrationRuntime,
  } as unknown as NexusRunServices
}

function overflowSequence(trueCount: number) {
  let calls = 0
  return vi.fn(() => {
    calls += 1
    return calls <= trueCount
  })
}

function compactionDouble(options: {
  result: CompactionResult
  overflowTrueCount: number
  onCompact?: () => void
}): {
  value: SessionCompaction
  compact: ReturnType<typeof vi.fn>
  prune: ReturnType<typeof vi.fn>
} {
  const compact = vi.fn(async () => {
    options.onCompact?.()
    return options.result
  })
  const prune = vi.fn()
  return {
    value: {
      prune,
      microcompact: vi.fn(() => 0),
      compact,
      isOverflow: overflowSequence(options.overflowTrueCount),
    } as unknown as SessionCompaction,
    compact,
    prune,
  }
}

function finalAnswerClient(onStream?: () => void): {
  value: LLMClient
  stream: ReturnType<typeof vi.fn>
} {
  const stream = vi.fn(() => (async function* () {
    onStream?.()
    yield { type: "text_delta" as const, delta: "done" }
    yield { type: "finish" as const, finishReason: "stop" as const }
  })())
  return {
    value: {
      providerName: "test",
      modelId: "test-model",
      stream,
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient,
    stream,
  }
}

async function runWith(options: {
  compaction: SessionCompaction
  client: LLMClient
  auto?: boolean
  session?: ReturnType<typeof createFakeSession>
  host?: ReturnType<typeof createFakeHost>
  tools?: ToolDef[]
}) {
  const cwd = process.cwd()
  const session = options.session ?? createFakeSession(cwd)
  if (session.messages.length === 0) {
    session.addMessage({ role: "user", content: "do work" })
  }
  const host = options.host ?? createFakeHost({ cwd })
  await runAgentLoop({
    session,
    client: options.client,
    host,
    config: createTestConfig({
      summarization: {
        auto: options.auto ?? true,
      },
    }),
    services: services(),
    mode: "agent",
    tools: options.tools ?? [],
    skills: [],
    rulesContent: "",
    compaction: options.compaction,
    signal: new AbortController().signal,
  })
  return { host, session }
}

describe("agent compaction failure safety", () => {
  it("honors summarization.auto=false without starting automatic compaction", async () => {
    const failure = new Error("must not compact")
    const compaction = compactionDouble({
      result: {
        status: "failed",
        reason: "summarizer_error",
        error: failure,
      },
      // The old path calls isOverflow three times before compacting. A final
      // false lets the regression terminate instead of hanging.
      overflowTrueCount: 3,
    })
    const client = finalAnswerClient()

    const { host } = await runWith({
      compaction: compaction.value,
      client: client.value,
      auto: false,
    })

    expect(client.stream).toHaveBeenCalledTimes(1)
    expect(compaction.compact).not.toHaveBeenCalled()
    expect(compaction.prune).not.toHaveBeenCalled()
    expect(
      host.events.filter((event) => event.type.startsWith("compaction_")),
    ).toEqual([])
  })

  it("stops after one failed automatic compaction and closes its event lifecycle", async () => {
    const failure = new Error("summarizer unavailable")
    const compaction = compactionDouble({
      result: {
        status: "failed",
        reason: "summarizer_error",
        error: failure,
      },
      // Two complete old preflight cycles (three overflow checks each) expose
      // the prior retry loop while remaining deterministic.
      overflowTrueCount: 6,
    })
    const client = finalAnswerClient()
    const host = createFakeHost({ cwd: process.cwd() })

    await expect(runWith({
      compaction: compaction.value,
      client: client.value,
      host,
    })).rejects.toBe(failure)

    expect(compaction.compact).toHaveBeenCalledTimes(1)
    expect(client.stream).not.toHaveBeenCalled()
    expect(
      host.events.filter((event) => event.type.startsWith("compaction_")),
    ).toEqual([
      { type: "compaction_start" },
      { type: "compaction_end" },
    ])
    expect(host.events).toContainEqual({
      type: "error",
      error: expect.stringMatching(/automatic compaction failed.*summarizer unavailable/i),
      fatal: true,
    })
  })

  it("reports a forced no-op as an error before closing the compaction lifecycle", async () => {
    const compaction = compactionDouble({
      result: {
        status: "skipped",
        reason: "no_new_messages",
      },
      overflowTrueCount: 3,
    })
    const client = finalAnswerClient()
    const host = createFakeHost({ cwd: process.cwd() })

    await expect(runWith({
      compaction: compaction.value,
      client: client.value,
      host,
    })).rejects.toThrow(/could not produce a summary/i)

    expect(
      host.events.filter(
        (event) =>
          event.type.startsWith("compaction_") ||
          (event.type === "error" &&
            /compaction.*could not produce a summary/i.test(event.error)),
      ),
    ).toEqual([
      { type: "compaction_start" },
      {
        type: "error",
        error: expect.stringMatching(/compaction.*could not produce a summary/i),
        fatal: true,
      },
      { type: "compaction_end" },
    ])
  })

  it("still forces a manual Condense when automatic compaction is disabled", async () => {
    const compaction = compactionDouble({
      result: {
        status: "compacted",
        summaryMessageId: "summary-manual",
      },
      overflowTrueCount: 0,
    })
    let providerCalls = 0
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream() {
        providerCalls += 1
        if (providerCalls === 1) {
          yield {
            type: "tool_call" as const,
            toolCallId: "condense-1",
            toolName: "Condense",
            toolInput: { reason: "manual request" },
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

    await runWith({
      compaction: compaction.value,
      client,
      auto: false,
      tools: [condenseTool],
    })

    expect(compaction.compact).toHaveBeenCalledTimes(1)
    expect(compaction.compact.mock.calls[0]?.[3]).toMatchObject({
      force: true,
    })
  })

  it("recovers a streamed context-overflow event once and never recompacts the retry", async () => {
    const compaction = compactionDouble({
      result: {
        status: "compacted",
        summaryMessageId: "summary-overflow",
      },
      overflowTrueCount: 0,
    })
    let providerCalls = 0
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream() {
        providerCalls += 1
        yield {
          type: "error" as const,
          error: new Error("maximum context length exceeded"),
        }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient
    const host = createFakeHost({ cwd: process.cwd() })

    await expect(runWith({
      compaction: compaction.value,
      client,
      host,
    })).rejects.toThrow(/still reports a context overflow after compaction/i)

    expect(providerCalls).toBe(2)
    expect(compaction.compact).toHaveBeenCalledTimes(1)
    expect(
      host.events.filter((event) => event.type.startsWith("compaction_")),
    ).toEqual([
      { type: "compaction_start" },
      { type: "compaction_end" },
    ])
  })

  it("does not recover a streamed overflow when automatic compaction is disabled", async () => {
    const compaction = compactionDouble({
      result: {
        status: "compacted",
        summaryMessageId: "must-not-run",
      },
      overflowTrueCount: 0,
    })
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream() {
        yield {
          type: "error" as const,
          error: new Error("maximum context length exceeded"),
        }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    await expect(runWith({
      compaction: compaction.value,
      client,
      auto: false,
    })).rejects.toThrow(/automatic compaction is disabled/i)

    expect(compaction.compact).not.toHaveBeenCalled()
  })

  it("persists a successful summary before retrying the provider turn", async () => {
    const order: string[] = []
    const session = createFakeSession()
    session.addMessage({ role: "user", content: "do work" })
    session.save = vi.fn(async () => {
      order.push("save")
    })
    const compaction = compactionDouble({
      result: {
        status: "compacted",
        summaryMessageId: "summary-1",
      },
      overflowTrueCount: 3,
      onCompact: () => order.push("compact"),
    })
    const client = finalAnswerClient(() => order.push("provider"))

    await runWith({
      compaction: compaction.value,
      client: client.value,
      session,
    })

    expect(order.slice(0, 3)).toEqual(["compact", "save", "provider"])
    expect(compaction.compact).toHaveBeenCalledTimes(1)
  })

  it("never retries the provider with a summary that failed to persist", async () => {
    const persistenceError = new Error("session journal unavailable")
    const session = createFakeSession()
    session.addMessage({ role: "user", content: "do work" })
    let saves = 0
    session.save = vi.fn(async () => {
      saves += 1
      if (saves === 1) throw persistenceError
    })
    const compaction = compactionDouble({
      result: {
        status: "compacted",
        summaryMessageId: "summary-not-durable",
      },
      overflowTrueCount: 3,
    })
    const client = finalAnswerClient()
    const host = createFakeHost({ cwd: process.cwd() })

    await expect(runWith({
      compaction: compaction.value,
      client: client.value,
      session,
      host,
    })).rejects.toBe(persistenceError)

    expect(client.stream).not.toHaveBeenCalled()
    expect(saves).toBe(2)
    expect(host.events).toContainEqual({
      type: "error",
      error: "Automatic compaction failed: session journal unavailable",
      fatal: true,
    })
  })
})
