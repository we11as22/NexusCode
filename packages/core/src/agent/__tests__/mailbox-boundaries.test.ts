import { beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import type {
  LLMClient,
  LLMMessage,
  StreamOptions,
} from "../../provider/types.js"
import { createCompaction } from "../../session/compaction.js"
import {
  createFakeHost,
  createFakeSession,
  createTestConfig,
} from "../../test/fakes.js"
import type {
  AgentInputMailbox,
  AgentMailboxMessage,
  ISession,
  ToolDef,
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

class TestMailbox implements AgentInputMailbox {
  private records: AgentMailboxMessage[] = []
  private acknowledged = new Set<string>()
  private waiters = new Set<() => void>()
  private readCount = 0
  onRead?: (count: number, pending: readonly AgentMailboxMessage[]) => void
  sealedForCompletion = false
  readonly checkpoints: Array<{
    ids: string[]
    markerIds: string[]
  }> = []

  enqueue(record: AgentMailboxMessage): void {
    this.records.push(record)
    for (const wake of this.waiters) wake()
    this.waiters.clear()
  }

  async readPending(limit = 128): Promise<AgentMailboxMessage[]> {
    const pending = this.records
      .filter((record) => !this.acknowledged.has(record.id))
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
    this.readCount += 1
    this.onRead?.(this.readCount, pending)
    return pending
  }

  waitForInput(signal: AbortSignal): Promise<void> {
    if (this.records.some((record) => !this.acknowledged.has(record.id))) {
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const wake = () => {
        cleanup()
        resolve()
      }
      const onAbort = () => {
        cleanup()
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"))
      }
      const cleanup = () => {
        this.waiters.delete(wake)
        signal.removeEventListener("abort", onAbort)
      }
      this.waiters.add(wake)
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
  }

  async checkpointAndAcknowledge(
    messages: readonly AgentMailboxMessage[],
    session: ISession,
  ): Promise<void> {
    const markerIds = session.messages
      .map((message) => message.mailboxMessageId)
      .filter((id): id is string => Boolean(id))
    this.checkpoints.push({
      ids: messages.map((message) => message.id),
      markerIds,
    })
    for (const message of messages) this.acknowledged.add(message.id)
  }

  sealForCompletion(): void {
    this.sealedForCompletion = true
  }

  reopenAfterCompletionCheck(): void {
    this.sealedForCompletion = false
  }
}

function mail(
  id: string,
  sequence: number,
  message: string,
): AgentMailboxMessage {
  return {
    id,
    ownerSessionId: "session_owner",
    targetAgentId: "subagent_worker",
    sequence,
    from: "lead",
    message,
    createdAt: sequence,
  }
}

function countMessageText(messages: LLMMessage[], text: string): number {
  return messages
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"))
    .filter((content) => content.includes(text))
    .length
}

async function runWithMailbox(input: {
  mailbox: AgentInputMailbox
  client: LLMClient
  tools?: ToolDef[]
  session?: ReturnType<typeof createFakeSession>
}) {
  const cwd = process.cwd()
  const session = input.session ?? createFakeSession(cwd)
  if (session.messages.length === 0) {
    session.addMessage({ role: "user", content: "start" })
  }
  const rootAbort = new AbortController()
  await runAgentLoop({
    session,
    executionIdentity: {
      workspaceId: "test-workspace",
      sessionId: session.id,
      turnId: "test-turn",
      runId: "test-run",
    },
    client: input.client,
    host: createFakeHost({ cwd }),
    config: createTestConfig({
      memory: { sessionMemoryEnabled: false },
      tools: { parallelReads: false },
    }),
    services: createNexusRunServices({
      orchestrationRuntime: orchestrationRuntime as never,
    }),
    mode: "agent",
    tools: input.tools ?? [],
    skills: [],
    rulesContent: "",
    compaction: createCompaction(),
    signal: rootAbort.signal,
    mailbox: input.mailbox,
  })
  return { session, rootAbort }
}

beforeEach(() => {
  runPluginHooks.mockClear()
})

describe("delegated-agent mailbox provider boundaries", () => {
  it("seals acceptance and rechecks mail before committing a normal completion", async () => {
    const mailbox = new TestMailbox()
    const requests: StreamOptions[] = []
    mailbox.onRead = (count) => {
      // Initial read, first loop-boundary read, then the post-stream read.
      // Queue in the microtask immediately after that final read so only the
      // completion handshake can observe it.
      if (count === 3) {
        queueMicrotask(() => {
          mailbox.enqueue(mail(
            "mail_after_stream_drain",
            1,
            "Handle the completion-edge message",
          ))
        })
      }
    }
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(request)
        yield {
          type: "text_delta" as const,
          delta: requests.length === 1 ? "first final" : "handled late mail",
        }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    const { session } = await runWithMailbox({ mailbox, client })

    expect(requests).toHaveLength(2)
    expect(countMessageText(
      requests[1]!.messages,
      "Handle the completion-edge message",
    )).toBe(1)
    expect(mailbox.checkpoints).toEqual([{
      ids: ["mail_after_stream_drain"],
      markerIds: ["mail_after_stream_drain"],
    }])
    expect(session.messages.filter(
      (message) =>
        message.mailboxMessageId === "mail_after_stream_drain",
    )).toHaveLength(1)
    expect(mailbox.sealedForCompletion).toBe(true)
  })

  it("interrupts only sampling and includes a message that races the final response in the next request", async () => {
    const mailbox = new TestMailbox()
    const requests: StreamOptions[] = []
    let firstStreamSignal: AbortSignal | undefined
    let releaseSampling!: () => void
    const samplingStarted = new Promise<void>((resolve) => {
      releaseSampling = resolve
    })
    let providerCall = 0
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(request)
        providerCall += 1
        if (providerCall === 1) {
          firstStreamSignal = request.signal
          yield { type: "text_delta" as const, delta: "premature final" }
          releaseSampling()
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 150)
            request.signal?.addEventListener("abort", () => {
              clearTimeout(timeout)
              resolve()
            }, { once: true })
          })
          if (request.signal?.aborted) throw request.signal.reason
          yield { type: "finish" as const, finishReason: "stop" as const }
          return
        }
        yield { type: "text_delta" as const, delta: "handled follow-up" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    const running = runWithMailbox({ mailbox, client })
    await samplingStarted
    mailbox.enqueue(mail("mail_race", 1, "Inspect the final race"))
    const { session, rootAbort } = await running

    expect(firstStreamSignal?.aborted).toBe(true)
    expect(rootAbort.signal.aborted).toBe(false)
    expect(requests).toHaveLength(2)
    expect(countMessageText(requests[1]!.messages, "Inspect the final race")).toBe(1)
    expect(mailbox.checkpoints).toEqual([{
      ids: ["mail_race"],
      markerIds: ["mail_race"],
    }])
    expect(session.messages.filter(
      (message) => message.mailboxMessageId === "mail_race",
    )).toHaveLength(1)
  })

  it("does not cancel a long tool and drains the mailbox after the tool boundary", async () => {
    const mailbox = new TestMailbox()
    const requests: StreamOptions[] = []
    let toolStarted!: () => void
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve
    })
    let releaseTool!: () => void
    const toolRelease = new Promise<void>((resolve) => {
      releaseTool = resolve
    })
    let toolSignalAborted: boolean | undefined
    const slowTool: ToolDef = {
      name: "SlowBoundaryTool",
      description: "Run a controlled long operation.",
      parameters: z.object({}),
      async execute(_args, ctx) {
        toolStarted()
        await toolRelease
        toolSignalAborted = ctx.signal.aborted
        return { success: true, output: "slow tool completed" }
      },
    }
    let providerCall = 0
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(request)
        providerCall += 1
        if (providerCall === 1) {
          yield {
            type: "tool_call" as const,
            toolCallId: "slow-1",
            toolName: "SlowBoundaryTool",
            toolInput: {},
          }
          if (request.signal?.aborted) throw request.signal.reason
          yield { type: "finish" as const, finishReason: "tool_calls" as const }
          return
        }
        yield { type: "text_delta" as const, delta: "continued safely" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    const running = runWithMailbox({
      mailbox,
      client,
      tools: [slowTool],
    })
    await started
    mailbox.enqueue(mail("mail_during_tool", 1, "Review the tool result"))
    await vi.waitFor(() => {
      expect(requests[0]!.signal?.aborted).toBe(true)
    })
    releaseTool()
    const { session, rootAbort } = await running

    expect(rootAbort.signal.aborted).toBe(false)
    expect(toolSignalAborted).toBe(false)
    expect(requests).toHaveLength(2)
    expect(countMessageText(requests[1]!.messages, "Review the tool result")).toBe(1)
    expect(JSON.stringify(session.messages)).toContain("slow tool completed")
  })

  it("deduplicates a crash-before-ack marker and acknowledges it only after checkpoint", async () => {
    const mailbox = new TestMailbox()
    mailbox.enqueue(mail("mail_replay", 1, "Already checkpointed"))
    const session = createFakeSession(process.cwd())
    session.addMessage({ role: "user", content: "start" })
    session.addMessage({
      role: "user",
      content: "[Message from lead | id: mail_replay]\nAlready checkpointed",
      mailboxMessageId: "mail_replay",
      mailboxOwnerSessionId: "session_owner",
      mailboxTargetAgentId: "subagent_worker",
      mailboxSender: "lead",
    })
    const requests: StreamOptions[] = []
    const client = {
      providerName: "test",
      modelId: "test-model",
      async *stream(request: StreamOptions) {
        requests.push(request)
        yield { type: "text_delta" as const, delta: "resumed" }
        yield { type: "finish" as const, finishReason: "stop" as const }
      },
      supportsStructuredOutput: () => false,
      getModel: () => ({}),
    } as unknown as LLMClient

    await runWithMailbox({ mailbox, client, session })

    expect(session.messages.filter(
      (message) => message.mailboxMessageId === "mail_replay",
    )).toHaveLength(1)
    expect(countMessageText(requests[0]!.messages, "Already checkpointed")).toBe(1)
    expect(mailbox.checkpoints).toEqual([{
      ids: ["mail_replay"],
      markerIds: ["mail_replay"],
    }])
    await expect(mailbox.readPending()).resolves.toEqual([])
  })
})
