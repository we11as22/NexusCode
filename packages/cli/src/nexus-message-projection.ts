import type { UUID } from "node:crypto"

import type { AgentEvent } from "@nexuscode/core"
import type { AssistantMessage, Message } from "./query.js"

export interface NexusAssistantDraft {
  messageId: string
  reasoning: string
  text: string
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
