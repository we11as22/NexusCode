import { randomUUID, type UUID } from "node:crypto"

import type { AgentEvent } from "@nexuscode/core"
import type { AssistantMessage, Message } from "./query.js"

export interface NexusAssistantDraft {
  messageId: string
  reasoning: string
  text: string
}

export interface NexusAssistantDraftPreview {
  reasoning: string
  text: string
}

export interface NexusAssistantDraftPublishDecision {
  publish: boolean
  nextVisible: NexusAssistantDraftPreview | null
}

export const NEXUS_COMPACTION_BOUNDARY_TEXT =
  "Conversation compacted. Earlier messages remain in the saved session, but were removed from the live terminal view."

/**
 * Stock Ink repaints every mounted row. Keeping an unbounded pre-compaction
 * transcript mounted makes each spinner tick and keystroke rewrite the entire
 * terminal. OpenClaude establishes a compact boundary and drops the older
 * non-fullscreen rows; Nexus does the same while the durable Session remains
 * authoritative on disk.
 */
export function compactTimelineAfterBoundary(
  _messages: readonly Message[],
): Message[] {
  const id = randomUUID()
  return [
    {
      type: "assistant",
      costUSD: 0,
      durationMs: 0,
      uuid: id,
      message: {
        id: `compaction-boundary-${id}`,
        model: "",
        role: "assistant",
        stop_reason: "end_turn",
        stop_sequence: "",
        type: "message",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        content: [{ type: "text", text: NEXUS_COMPACTION_BOUNDARY_TEXT }],
      },
    },
  ]
}

function completeLines(value: string): string {
  const lastNewline = value.lastIndexOf("\n")
  return lastNewline < 0 ? "" : value.slice(0, lastNewline + 1)
}

/**
 * The official OpenClaude renderer keeps the full stream in a ref but only
 * publishes complete visible lines into React. Nexus keeps the authoritative
 * draft in `assistantDrafts`; this decision prevents hidden reasoning and a
 * changing trailing line from repainting the entire Ink transcript.
 */
export function decideAssistantDraftPublish(
  draft: NexusAssistantDraft,
  showReasoning: boolean,
  lastVisible: NexusAssistantDraftPreview | null,
): NexusAssistantDraftPublishDecision {
  const nextVisible = {
    reasoning: showReasoning ? completeLines(draft.reasoning) : "",
    text: completeLines(draft.text),
  }
  const hasVisibleContent =
    nextVisible.reasoning.length > 0 || nextVisible.text.length > 0
  const changed =
    lastVisible?.reasoning !== nextVisible.reasoning ||
    lastVisible?.text !== nextVisible.text

  if (!hasVisibleContent || !changed) {
    return { publish: false, nextVisible: lastVisible }
  }
  return { publish: true, nextVisible }
}

export function projectVisibleAssistantDraft(
  draft: NexusAssistantDraft,
  preview: NexusAssistantDraftPreview,
): AssistantMessage {
  return projectAssistantDraft({
    messageId: draft.messageId,
    reasoning: preview.reasoning,
    text: preview.text,
  })
}

export function isStreamingDraftEvent(event: AgentEvent): boolean {
  return event.type === "text_delta" || event.type === "reasoning_delta"
}

export function enqueueProjectedAgentEvent(
  queue: AgentEvent[],
  event: AgentEvent,
): void {
  const previous = queue[queue.length - 1]
  if (
    event.type === "text_delta" &&
    previous?.type === "text_delta" &&
    previous.messageId === event.messageId
  ) {
    queue[queue.length - 1] = {
      ...previous,
      ...event,
      delta: previous.delta + event.delta,
    }
    return
  }
  if (
    event.type === "reasoning_delta" &&
    previous?.type === "reasoning_delta" &&
    previous.messageId === event.messageId &&
    previous.reasoningId === event.reasoningId
  ) {
    queue[queue.length - 1] = {
      ...previous,
      ...event,
      delta: previous.delta + event.delta,
    }
    return
  }
  queue.push(event)
}

export function nexusAssistantMessageUuid(messageId: string): UUID {
  return `nexus-assistant-${messageId}` as UUID
}

export function reduceAssistantDraft(
  draft: NexusAssistantDraft | undefined,
  event: AgentEvent,
): NexusAssistantDraft | undefined {
  if (
    event.type !== "assistant_message_started" &&
    event.type !== "text_delta" &&
    event.type !== "reasoning_start" &&
    event.type !== "reasoning_delta" &&
    event.type !== "reasoning_end"
  ) {
    return draft
  }

  const current =
    draft?.messageId === event.messageId
      ? draft
      : {
          messageId: event.messageId,
          reasoning: "",
          text: "",
        }

  if (event.type === "text_delta") {
    return { ...current, text: current.text + event.delta }
  }
  if (event.type === "reasoning_delta") {
    return { ...current, reasoning: current.reasoning + event.delta }
  }
  return current
}

export function projectAssistantDraft(
  draft: NexusAssistantDraft,
): AssistantMessage {
  const content: AssistantMessage["message"]["content"] = []
  if (draft.reasoning) {
    content.push({
      type: "thinking",
      thinking: draft.reasoning,
      signature: "",
    })
  }
  if (draft.text) {
    content.push({ type: "text", text: draft.text })
  }
  return {
    type: "assistant",
    costUSD: 0,
    durationMs: 0,
    uuid: nexusAssistantMessageUuid(draft.messageId),
    message: {
      id: draft.messageId,
      model: "",
      role: "assistant",
      stop_reason: null,
      stop_sequence: null,
      type: "message",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content,
    },
  }
}

export function upsertTimelineMessage(
  messages: Message[],
  incoming: Message,
): Message[] {
  const index = messages.findIndex((message) => message.uuid === incoming.uuid)
  if (index < 0) return [...messages, incoming]
  return [
    ...messages.slice(0, index),
    incoming,
    ...messages.slice(index + 1),
  ]
}
