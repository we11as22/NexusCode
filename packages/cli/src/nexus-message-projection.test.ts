import { describe, expect, it } from "vitest"

import type { AgentEvent } from "@nexuscode/core"
import type { Message } from "./query.js"
import {
  compactTimelineAfterBoundary,
  decideAssistantDraftPublish,
  enqueueProjectedAgentEvent,
  isStreamingDraftEvent,
  nexusAssistantMessageUuid,
  projectAssistantDraft,
  projectVisibleAssistantDraft,
  reduceAssistantDraft,
  upsertTimelineMessage,
} from "./nexus-message-projection.js"

describe("CLI compaction timeline projection", () => {
  it("drops the pre-compaction transcript and generated summary from the live Ink tree", () => {
    const previous = [
      {
        type: "user" as const,
        uuid: "old-user",
        message: { role: "user" as const, content: "old user message" },
      },
      projectAssistantDraft({
        messageId: "old-assistant",
        reasoning: "",
        text: "old assistant message",
      }),
    ] as Message[]

    const compacted = compactTimelineAfterBoundary(previous)
    const serialized = JSON.stringify(compacted)

    expect(compacted).toHaveLength(1)
    expect(serialized).toContain("Conversation compacted")
    expect(serialized).not.toContain("old user message")
    expect(serialized).not.toContain("old assistant message")
  })
})

describe("CLI assistant stream projection", () => {
  it("publishes only visible complete lines and suppresses hidden reasoning churn", () => {
    const hiddenReasoning = decideAssistantDraftPublish(
      {
        messageId: "assistant-preview",
        reasoning: "private chain fragment",
        text: "",
      },
      false,
      null,
    )
    expect(hiddenReasoning).toEqual({
      publish: false,
      nextVisible: null,
    })

    const partialLine = decideAssistantDraftPublish(
      {
        messageId: "assistant-preview",
        reasoning: "private chain fragment",
        text: "partial",
      },
      false,
      hiddenReasoning.nextVisible,
    )
    expect(partialLine).toEqual({
      publish: false,
      nextVisible: null,
    })

    const completeLine = decideAssistantDraftPublish(
      {
        messageId: "assistant-preview",
        reasoning: "private chain fragment",
        text: "partial\n",
      },
      false,
      partialLine.nextVisible,
    )
    expect(completeLine).toEqual({
      publish: true,
      nextVisible: {
        reasoning: "",
        text: "partial\n",
      },
    })

    const trailingFragment = decideAssistantDraftPublish(
      {
        messageId: "assistant-preview",
        reasoning: "private chain fragment still streaming",
        text: "partial\nnext",
      },
      false,
      completeLine.nextVisible,
    )
    expect(trailingFragment).toEqual({
      publish: false,
      nextVisible: completeLine.nextVisible,
    })
  })

  it("publishes completed reasoning lines only when reasoning is visible", () => {
    const result = decideAssistantDraftPublish(
      {
        messageId: "assistant-reasoning",
        reasoning: "Inspecting files\n",
        text: "",
      },
      true,
      null,
    )

    expect(result).toEqual({
      publish: true,
      nextVisible: {
        reasoning: "Inspecting files\n",
        text: "",
      },
    })
  })

  it("flushes the final partial line at a semantic stream boundary", () => {
    const result = decideAssistantDraftPublish(
      {
        messageId: "assistant-final-fragment",
        reasoning: "private unfinished reasoning",
        text: "Done without a trailing newline",
      },
      false,
      null,
      true,
    )

    expect(result).toEqual({
      publish: true,
      nextVisible: {
        reasoning: "",
        text: "Done without a trailing newline",
      },
    })
  })

  it("projects only the approved visible preview, never hidden reasoning or a partial tail", () => {
    const projected = projectVisibleAssistantDraft(
      {
        messageId: "assistant-visible",
        reasoning: "private reasoning\n",
        text: "complete\npartial tail",
      },
      {
        reasoning: "",
        text: "complete\n",
      },
    )
    const serialized = JSON.stringify(projected)

    expect(serialized).toContain("complete")
    expect(serialized).not.toContain("private reasoning")
    expect(serialized).not.toContain("partial tail")
  })

  it("coalesces only high-frequency draft events, never control events", () => {
    expect(
      isStreamingDraftEvent({
        type: "text_delta",
        messageId: "assistant-1",
        delta: "x",
      }),
    ).toBe(true)
    expect(
      isStreamingDraftEvent({
        type: "tool_approval_needed",
        partId: "part-1",
        action: {
          type: "execute",
          tool: "Bash",
          description: "Run pwd",
        },
      }),
    ).toBe(false)
  })

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
