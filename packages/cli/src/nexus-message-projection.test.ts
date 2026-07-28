import { describe, expect, it } from "vitest"

import type { AgentEvent } from "@nexuscode/core"
import type { Message } from "./query.js"
import {
  enqueueProjectedAgentEvent,
  nexusAssistantMessageUuid,
  projectAssistantDraft,
  reduceAssistantDraft,
  upsertTimelineMessage,
} from "./nexus-message-projection.js"

describe("CLI assistant stream projection", () => {
  it("coalesces adjacent stream deltas before the TUI can fall behind", () => {
    const queue: AgentEvent[] = []

    enqueueProjectedAgentEvent(queue, {
      type: "text_delta",
      messageId: "assistant-queue",
      delta: "one",
    })
    enqueueProjectedAgentEvent(queue, {
      type: "text_delta",
      messageId: "assistant-queue",
      delta: " two",
    })

    expect(queue).toEqual([
      {
        type: "text_delta",
        messageId: "assistant-queue",
        delta: "one two",
      },
    ])
  })

  it("accumulates text and reasoning deltas under the exact assistant identity", () => {
    const events: AgentEvent[] = [
      {
        type: "assistant_message_started",
        messageId: "assistant-1",
      },
      {
        type: "reasoning_delta",
        messageId: "assistant-1",
        reasoningId: "reasoning-1",
        delta: "Inspecting ",
      },
      {
        type: "reasoning_delta",
        messageId: "assistant-1",
        reasoningId: "reasoning-1",
        delta: "files",
      },
      {
        type: "text_delta",
        messageId: "assistant-1",
        delta: "Done",
      },
    ]

    const draft = events.reduce(reduceAssistantDraft, undefined)
    const projected = projectAssistantDraft(draft!)

    expect(projected.uuid).toBe("nexus-assistant-assistant-1")
    expect(projected.message.id).toBe("assistant-1")
    expect(projected.message.content).toEqual([
      {
        type: "thinking",
        thinking: "Inspecting files",
        signature: "",
      },
      {
        type: "text",
        text: "Done",
      },
    ])
  })

  it("replaces the live draft with the authoritative completion without adding a duplicate row", () => {
    const live = projectAssistantDraft({
      messageId: "assistant-2",
      reasoning: "",
      text: "partial",
    })
    const completed = {
      ...live,
      message: {
        ...live.message,
        content: [{ type: "text" as const, text: "complete" }],
      },
    }
    const user = {
      type: "user" as const,
      uuid: "user-1",
      message: { role: "user" as const, content: "hello" },
    }

    const result = upsertTimelineMessage(
      upsertTimelineMessage([user] as Message[], live),
      completed,
    )

    expect(result).toHaveLength(2)
    expect(result[0]).toBe(user)
    expect(result[1]).toMatchObject({
      uuid: nexusAssistantMessageUuid("assistant-2"),
      message: {
        id: "assistant-2",
        content: [{ type: "text", text: "complete" }],
      },
    })
  })
})
