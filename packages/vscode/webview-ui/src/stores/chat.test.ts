import { beforeEach, describe, expect, it, vi } from "vitest"

import { createExtensionMessageBuffer } from "../bridge/message-buffer.js"
import { mergeStateMessagesForStream } from "../transcript/helpers.js"
import { useChatStore } from "./chat.js"

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    mode: "agent",
    isRunning: true,
    awaitingApproval: false,
    pendingApproval: null,
    queuedMessages: [],
    activePresetName: "Default",
    subagents: [],
    runtimeTasks: [],
    lastSpawnAgentPartId: null,
  })
})

describe("agent-event delivery", () => {
  it("preserves provider and pending context diagnostics", () => {
    useChatStore.getState().handleAgentEvent({
      type: "context_usage",
      usedTokens: 29_300,
      limitTokens: 256_000,
      percent: 11,
      source: "hybrid",
      providerTokens: 27_800,
      pendingTokens: 1_500,
    })

    expect(useChatStore.getState()).toMatchObject({
      contextUsedTokens: 29_300,
      contextLimitTokens: 256_000,
      contextPercent: 11,
      contextSource: "hybrid",
      contextProviderTokens: 27_800,
      contextPendingTokens: 1_500,
    })
  })

  it("clears session-scoped context immediately when creating a new session", () => {
    useChatStore.setState({
      messages: [
        {
          id: "old-user",
          ts: 1,
          role: "user",
          content: "old session",
        },
      ],
      sessionId: "session-old",
      contextUsedTokens: 24_500,
      contextLimitTokens: 128_000,
      contextPercent: 19,
      todo: "old todo",
      subagents: [
        {
          id: "agent-old",
          mode: "ask",
          task: "old task",
          status: "completed",
          toolHistory: [],
          toolUsesCount: 0,
          startedAt: 1,
        },
      ],
    })

    useChatStore.getState().createNewSession()

    expect(useChatStore.getState()).toMatchObject({
      contextUsedTokens: 0,
      contextPercent: 0,
      view: "chat",
    })
  })

  it("derives the actionable approval state from the authoritative agent event", () => {
    const action = {
      type: "execute" as const,
      tool: "Bash",
      description: "Run pwd",
      content: "pwd",
    }

    useChatStore.getState().handleAgentEvent({
      type: "tool_approval_needed",
      partId: "tool-bash-1",
      action,
    })

    expect(useChatStore.getState()).toMatchObject({
      awaitingApproval: true,
      pendingApproval: {
        partId: "tool-bash-1",
        action,
      },
    })
  })

  it("projects modern task and background lifecycle events", () => {
    const handle = useChatStore.getState().handleAgentEvent
    handle({
      type: "task_created",
      task: {
        id: "task-1",
        kind: "agent",
        subject: "Inspect permissions",
        status: "pending",
        updatedAt: 10,
      },
    })
    handle({
      type: "task_tool_start",
      taskId: "task-1",
      taskKind: "agent",
      tool: "Grep",
    })
    handle({
      type: "background_task_updated",
      task: {
        id: "bash-1",
        kind: "bash",
        status: "completed",
        description: "Run typecheck",
        updatedAt: 20,
        exitCode: 0,
        outputPreview: "Done",
      },
    })

    expect(useChatStore.getState().runtimeTasks).toEqual([
      expect.objectContaining({
        id: "task-1",
        status: "running",
        currentTool: "Grep",
      }),
      expect.objectContaining({
        id: "bash-1",
        kind: "shell",
        status: "completed",
        exitCode: 0,
      }),
    ])
  })

  it("preserves identical text chunks delivered at distinct transport sequences", () => {
    const handle = useChatStore.getState().handleAgentEvent
    handle({
      type: "assistant_message_started",
      messageId: "assistant-identical-chunks",
    })
    handle({
      type: "text_delta",
      messageId: "assistant-identical-chunks",
      delta: "same",
    })
    handle({
      type: "text_delta",
      messageId: "assistant-identical-chunks",
      delta: "same",
    })

    expect(useChatStore.getState().messages.at(-1)?.content).toBe("samesame")
  })

  it("keeps an active run alive after a non-fatal diagnostic", () => {
    useChatStore.getState().handleAgentEvent({
      type: "error",
      error: "[MCP optional] unavailable",
      fatal: false,
    })

    expect(useChatStore.getState().isRunning).toBe(true)
    expect(useChatStore.getState().messages.at(-1)?.content).toContain(
      "[MCP optional] unavailable",
    )
  })

  it("does not add a false fallback when a stale optimistic user row trails the completed reply", () => {
    useChatStore.setState({
      messages: [
        {
          id: "local_user_1",
          ts: 1,
          role: "user",
          content: "Reply exactly",
        },
        {
          id: "assistant_1",
          ts: 2,
          role: "assistant",
          content: [{ type: "text", text: "VSCODE_OK" }],
        },
        {
          id: "local_user_1",
          ts: 1,
          role: "user",
          content: "Reply exactly",
        },
      ],
      isRunning: true,
    })

    useChatStore.getState().handleAgentEvent({
      type: "done",
      messageId: "assistant_1",
    })

    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({ id: "local_user_1", role: "user" }),
      expect.objectContaining({
        id: "assistant_1",
        role: "assistant",
        content: [{ type: "text", text: "VSCODE_OK" }],
      }),
    ])
  })

  it("uses the completed message id instead of transcript tail when deciding fallback", () => {
    useChatStore.setState({
      messages: [
        {
          id: "durable_user_1",
          ts: 1,
          role: "user",
          content: "Reply exactly",
        },
        {
          id: "assistant_1",
          ts: 2,
          role: "assistant",
          content: [{ type: "text", text: "VSCODE_OK" }],
        },
        {
          id: "local_user_1",
          ts: 1,
          role: "user",
          content: "Reply exactly",
        },
      ],
      isRunning: true,
    })

    useChatStore.getState().handleAgentEvent({
      type: "done",
      messageId: "assistant_1",
    })

    expect(useChatStore.getState().messages).toHaveLength(3)
    expect(useChatStore.getState().messages).not.toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("completed without a final"),
      }),
    )
  })

  it("keeps the turn duration on a generated fallback answer", () => {
    useChatStore.setState({
      messages: [
        {
          id: "user_tool_only",
          ts: 1,
          role: "user",
          content: "Inspect it",
        },
        {
          id: "assistant_tool_only",
          ts: 2,
          role: "assistant",
          content: [
            {
              type: "tool",
              id: "read-1",
              tool: "Read",
              status: "completed",
              input: { path: "src/index.ts" },
              output: "source",
            },
          ],
        },
      ],
      isRunning: true,
    })

    useChatStore.getState().handleAgentEvent({
      type: "done",
      messageId: "assistant_tool_only",
      durationMs: 4_200,
    })

    expect(useChatStore.getState().messages.at(-1)).toMatchObject({
      role: "assistant",
      durationMs: 4_200,
      content: expect.stringContaining("completed without a final"),
    })
  })

  it("deduplicates exact retries and coalesces distinct adjacent deltas", () => {
    const animationFrames: FrameRequestCallback[] = []
    vi.stubGlobal("window", {
      requestAnimationFrame(callback: FrameRequestCallback) {
        animationFrames.push(callback)
        return animationFrames.length
      },
      cancelAnimationFrame() {},
    })
    const events: unknown[] = []
    const store = {
      handleStateUpdate() {},
      handleSubmissionResult() {},
      handleAgentEvent(event: unknown) {
        events.push(event)
      },
      handleIndexStatus() {},
      handleSessionList() {},
      handleSessionListLoading() {},
      handleConfigLoaded() {},
      handleMcpServerStatus() {},
      handleSlashCommandCatalog() {},
      handlePendingApproval() {},
      appendToInput() {},
      handleModelsCatalog() {},
      handleAgentPresets() {},
      handleAgentPresetOptions() {},
      handleSkillDefinitions() {},
      setView() {},
    }
    const buffer = createExtensionMessageBuffer(store)
    const repeated = {
      type: "agentEvent" as const,
      seq: 41,
      event: {
        type: "text_delta",
        messageId: "assistant-sequence",
        delta: "same",
      },
    }
    buffer.enqueue(repeated)
    buffer.enqueue(structuredClone(repeated))
    buffer.enqueue({
      ...repeated,
      seq: 42,
    })
    animationFrames.shift()?.(0)

    expect(events).toEqual([
      {
        type: "text_delta",
        messageId: "assistant-sequence",
        delta: "samesame",
      },
    ])
    buffer.dispose()
    vi.unstubAllGlobals()
  })

  it("flushes coalesced text before a terminal boundary event", () => {
    const animationFrames: FrameRequestCallback[] = []
    vi.stubGlobal("window", {
      requestAnimationFrame(callback: FrameRequestCallback) {
        animationFrames.push(callback)
        return animationFrames.length
      },
      cancelAnimationFrame() {},
    })
    const events: unknown[] = []
    const store = {
      handleStateUpdate() {},
      handleSubmissionResult() {},
      handleAgentEvent(event: unknown) {
        events.push(event)
      },
      handleIndexStatus() {},
      handleSessionList() {},
      handleSessionListLoading() {},
      handleConfigLoaded() {},
      handleMcpServerStatus() {},
      handleSlashCommandCatalog() {},
      handlePendingApproval() {},
      appendToInput() {},
      handleModelsCatalog() {},
      handleAgentPresets() {},
      handleAgentPresetOptions() {},
      handleSkillDefinitions() {},
      setView() {},
    }
    const buffer = createExtensionMessageBuffer(store)
    buffer.enqueue({
      type: "agentEvent",
      seq: 1,
      event: {
        type: "text_delta",
        messageId: "assistant-1",
        delta: "smooth ",
      },
    })
    buffer.enqueue({
      type: "agentEvent",
      seq: 2,
      event: {
        type: "text_delta",
        messageId: "assistant-1",
        delta: "stream",
      },
    })
    buffer.enqueue({
      type: "agentEvent",
      seq: 3,
      event: {
        type: "done",
        messageId: "assistant-1",
        durationMs: 20,
      },
    })
    animationFrames.shift()?.(0)

    expect(events).toEqual([
      {
        type: "text_delta",
        messageId: "assistant-1",
        delta: "smooth stream",
      },
      {
        type: "done",
        messageId: "assistant-1",
        durationMs: 20,
      },
    ])
    buffer.dispose()
    vi.unstubAllGlobals()
  })
})

describe("message admission", () => {
  it("keeps the active run mode immutable in the webview store", () => {
    useChatStore.setState({
      isRunning: true,
      mode: "debug",
    })

    useChatStore.getState().setMode("ask")

    expect(useChatStore.getState().mode).toBe("debug")
  })

  it("queues the complete next-turn payload while a run is active", () => {
    useChatStore.setState({
      isRunning: true,
      mode: "debug",
      activePresetName: "Careful",
      inputValue: "follow up",
      attachedImages: [
        {
          id: "image-queued",
          data: "aGVsbG8=",
          mimeType: "image/png",
        },
      ],
    })

    useChatStore.getState().addToQueue("follow up")

    expect(useChatStore.getState().queuedMessages).toEqual([
      expect.objectContaining({
        text: "follow up",
        mode: "debug",
        presetName: "Careful",
        images: [
          expect.objectContaining({
            id: "image-queued",
            mimeType: "image/png",
          }),
        ],
      }),
    ])
    expect(useChatStore.getState().inputValue).toBe("")
    expect(useChatStore.getState().attachedImages).toEqual([])
  })

  it("rolls back an optimistic row and restores its draft after rejection", () => {
    useChatStore.setState({
      isRunning: false,
      mode: "agent",
      activePresetName: "Default",
      inputValue: "inspect this",
      attachedImages: [
        {
          id: "image-1",
          data: "aGVsbG8=",
          mimeType: "image/png",
        },
      ],
    })

    useChatStore.getState().sendMessage("inspect this", {
      mode: "debug",
      presetName: "Careful",
    })
    const optimistic = useChatStore.getState().messages.at(-1)
    expect(optimistic?.id).toMatch(/^local_user_/u)

    useChatStore.getState().handleSubmissionResult(
      optimistic!.id,
      false,
    )

    const state = useChatStore.getState()
    expect(state.messages).not.toContainEqual(
      expect.objectContaining({ id: optimistic!.id }),
    )
    expect(state.inputValue).toBe("inspect this")
    expect(state.attachedImages).toEqual([
      expect.objectContaining({ id: "image-1" }),
    ])
    expect(state.isRunning).toBe(false)
    expect(state.mode).toBe("debug")
    expect(state.activePresetName).toBe("Careful")
  })

  it("keeps an optimistic row after durable admission", () => {
    useChatStore.setState({
      isRunning: false,
      inputValue: "continue",
      attachedImages: [],
    })

    useChatStore.getState().sendMessage("continue")
    const optimistic = useChatStore.getState().messages.at(-1)!

    useChatStore.getState().handleSubmissionResult(
      optimistic.id,
      true,
    )

    expect(useChatStore.getState().messages).toContainEqual(optimistic)
  })
})

describe("transcript reconciliation", () => {
  it("matches repeated optimistic user messages one-to-one in FIFO order", () => {
    const previous = [
      {
        id: "local_user_first",
        ts: 10,
        role: "user" as const,
        content: "да",
      },
      {
        id: "local_user_second",
        ts: 20,
        role: "user" as const,
        content: "да",
      },
    ]
    const incoming = [
      {
        id: "server_user_first",
        ts: 30,
        role: "user" as const,
        content: "да",
      },
      {
        id: "server_user_second",
        ts: 40,
        role: "user" as const,
        content: "да",
      },
    ]

    expect(
      mergeStateMessagesForStream(previous, incoming).map((message) => message.id),
    ).toEqual(["local_user_first", "local_user_second"])
  })

  it("does not remap an older durable message to the newest optimistic row", () => {
    const previous = [
      {
        id: "server_user_old",
        ts: 10,
        role: "user" as const,
        content: "продолжай",
      },
      {
        id: "server_assistant_old",
        ts: 20,
        role: "assistant" as const,
        content: "готово",
      },
      {
        id: "local_user_new",
        ts: 30,
        role: "user" as const,
        content: "продолжай",
      },
    ]
    const incoming = [
      previous[0]!,
      previous[1]!,
      {
        id: "server_user_new",
        ts: 40,
        role: "user" as const,
        content: "продолжай",
      },
    ]

    expect(
      mergeStateMessagesForStream(previous, incoming).map((message) => message.id),
    ).toEqual([
      "server_user_old",
      "server_assistant_old",
      "local_user_new",
    ])
  })

  it("reconciles a new durable user even when its completed assistant is already known", () => {
    const previous = [
      {
        id: "server_user_old",
        ts: 10,
        role: "user" as const,
        content: "older",
      },
      {
        id: "server_assistant_old",
        ts: 20,
        role: "assistant" as const,
        content: "older reply",
      },
      {
        id: "local_user_new",
        ts: 30,
        role: "user" as const,
        content: "new turn",
      },
      {
        id: "server_assistant_new",
        ts: 40,
        role: "assistant" as const,
        content: "new reply",
      },
    ]
    const incoming = [
      previous[0]!,
      previous[1]!,
      {
        id: "server_user_new",
        ts: 35,
        role: "user" as const,
        content: "new turn",
      },
      previous[3]!,
    ]

    expect(
      mergeStateMessagesForStream(previous, incoming).map((message) => message.id),
    ).toEqual([
      "server_user_old",
      "server_assistant_old",
      "local_user_new",
      "server_assistant_new",
    ])
  })
})
