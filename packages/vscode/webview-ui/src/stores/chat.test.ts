import { beforeEach, describe, expect, it, vi } from "vitest"

import { createExtensionMessageBuffer } from "../bridge/message-buffer.js"
import { mergeStateMessagesForStream } from "../transcript/helpers.js"
import { useChatStore } from "./chat.js"

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    isRunning: true,
    awaitingApproval: false,
    pendingApproval: null,
    queuedMessages: [],
    subagents: [],
    lastSpawnAgentPartId: null,
  })
})

describe("agent-event delivery", () => {
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

  it("deduplicates only an exact repeated transport sequence", () => {
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

    expect(events).toHaveLength(2)
    buffer.dispose()
    vi.unstubAllGlobals()
  })
})

describe("message admission", () => {
  it("rolls back an optimistic row and restores its draft after rejection", () => {
    useChatStore.setState({
      isRunning: false,
      inputValue: "inspect this",
      attachedImages: [
        {
          id: "image-1",
          data: "aGVsbG8=",
          mimeType: "image/png",
        },
      ],
    })

    useChatStore.getState().sendMessage("inspect this")
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
})
