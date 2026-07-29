import type { MessagePart, ReasoningPart, SessionMessage, ToolPart } from "../stores/chat.js"
import {
  dedupeExplorationPrefixItems,
  getAssistantDisplaySegments,
  type ExploredPrefixItem,
} from "../components/ExploredProgressBlock.js"

const TODO_TOOL_NAMES = new Set(["TodoWrite", "update_todo_list"])
const PLACEHOLDER_TEXT = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."

export type ChatRenderLeaf =
  | {
      type: "message"
      key: string
      message: SessionMessage
      messageIndex: number
      isComplete: boolean
    }
  | {
      type: "assistant_part"
      key: string
      message: SessionMessage
      messageIndex: number
      isComplete: boolean
      parts: MessagePart[]
      part: MessagePart
      partIndex: number
      canonicalReplyIndex: number
      isLastPart: boolean
    }
  | {
      type: "explored"
      key: string
      prefixItems: ExploredPrefixItem[]
      isRunning: boolean
    }
export type ChatRenderItem =
  | ChatRenderLeaf
  | {
      type: "completed_work"
      key: string
      durationMs: number
      items: ChatRenderLeaf[]
    }

function getCanonicalReplyIndex(parts: MessagePart[]): number {
  const textPartIndices = parts
    .map((part, index) => (part.type === "text" ? index : -1))
    .filter((index) => index >= 0)
  if (textPartIndices.length === 0) return -1
  const withUserMessage = textPartIndices.filter((index) => ((parts[index] as { user_message?: string }).user_message?.trim()))
  if (withUserMessage.length > 0) return withUserMessage[withUserMessage.length - 1]!
  return textPartIndices[textPartIndices.length - 1]!
}

function hasVisibleTextPart(part: MessagePart): boolean {
  if (part.type !== "text") return false
  const textPart = part as { text?: string; user_message?: string }
  return Boolean(textPart.text?.trim() || textPart.user_message?.trim())
}

function isReasoningPartRenderable(part: MessagePart): boolean {
  if (part.type !== "reasoning") return false
  const reasoning = part as { text?: string }
  return Boolean(reasoning.text?.trim()) && reasoning.text !== PLACEHOLDER_TEXT
}

function assistantPartStableKey(messageId: string, part: MessagePart, partIndex: number): string {
  if (part.type === "tool") return `${messageId}-tool-${(part as ToolPart).id}`
  if (part.type === "reasoning") {
    const r = part as ReasoningPart
    return `${messageId}-reasoning-${r.reasoningId ?? "noid"}-${partIndex}`
  }
  if (part.type === "text") return `${messageId}-text-${partIndex}`
  return `${messageId}-part-${partIndex}`
}

function explorationSegmentIsRunning(
  prefixItems: ExploredPrefixItem[],
): boolean {
  return prefixItems.some((item) => {
    if (item.type === "tool") {
      return item.part.status === "pending" || item.part.status === "running"
    }
    if (item.type === "reasoning") return item.durationMs == null
    return false
  })
}

function coalesceAdjacentExplored(
  items: ChatRenderLeaf[],
): ChatRenderLeaf[] {
  const coalesced: ChatRenderLeaf[] = []
  for (const item of items) {
    const previous = coalesced[coalesced.length - 1]
    if (item.type === "explored" && previous?.type === "explored") {
      coalesced[coalesced.length - 1] = {
        ...previous,
        prefixItems: dedupeExplorationPrefixItems([
          ...previous.prefixItems,
          ...item.prefixItems,
        ]),
        isRunning: previous.isRunning || item.isRunning,
      }
      continue
    }
    coalesced.push(item)
  }
  return coalesced
}

function buildMessageRenderItems(
  message: SessionMessage,
  messageIndex: number,
  messages: SessionMessage[],
  isRunning: boolean,
): ChatRenderLeaf[] {
  const renderItems: ChatRenderLeaf[] = []
    const isComplete = !isRunning || messageIndex < messages.length - 1

    if (message.role !== "assistant" || typeof message.content === "string" || !Array.isArray(message.content)) {
      renderItems.push({
        type: "message",
        key: message.id,
        message,
        messageIndex,
        isComplete,
      })
      return renderItems
    }

    const parts = message.content as MessagePart[]
    const canonicalReplyIndex = getCanonicalReplyIndex(parts)
    const segments = getAssistantDisplaySegments(parts)

    segments.forEach((segment) => {
      if (segment.type === "explored") {
        if (segment.prefixItems.length === 0) return
        renderItems.push({
          type: "explored",
          // Stable across streaming appends within the same wave (endIndex grows).
          key: `${message.id}-explored-${segment.startIndex}`,
          prefixItems: segment.prefixItems,
          isRunning: Boolean(
            isRunning &&
            !isComplete &&
            explorationSegmentIsRunning(segment.prefixItems),
          ),
        })
        return
      }

      const { part, index: partIndex } = segment
      if (part.type === "tool" && TODO_TOOL_NAMES.has((part as ToolPart).tool)) return
      if (part.type === "reasoning" && !isReasoningPartRenderable(part)) return
      if (part.type === "text" && !hasVisibleTextPart(part)) return
      renderItems.push({
        type: "assistant_part",
        key: assistantPartStableKey(message.id, part, partIndex),
        message,
        messageIndex,
        isComplete,
        parts,
        part,
        partIndex,
        canonicalReplyIndex,
        isLastPart: partIndex === parts.length - 1,
      })
    })

  return renderItems
}

function nextUserMessageIndex(
  messages: SessionMessage[],
  startIndex: number,
): number {
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") return index
  }
  return messages.length
}

function completedAssistantIndex(
  messages: SessionMessage[],
  startIndex: number,
  endIndex: number,
): number {
  for (let index = endIndex - 1; index > startIndex; index -= 1) {
    const message = messages[index]
    if (
      message?.role === "assistant" &&
      typeof message.durationMs === "number" &&
      Number.isFinite(message.durationMs) &&
      message.durationMs >= 0
    ) {
      return index
    }
  }
  return -1
}

export function buildChatRenderItems(
  messages: SessionMessage[],
  isRunning: boolean,
): ChatRenderItem[] {
  const renderItems: ChatRenderItem[] = []

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!
    if (message.role !== "user") {
      renderItems.push(
        ...buildMessageRenderItems(
          message,
          messageIndex,
          messages,
          isRunning,
        ),
      )
      continue
    }

    renderItems.push(
      ...buildMessageRenderItems(
        message,
        messageIndex,
        messages,
        isRunning,
      ),
    )
    const endIndex = nextUserMessageIndex(messages, messageIndex)
    const finalAssistantIndex = completedAssistantIndex(
      messages,
      messageIndex,
      endIndex,
    )
    if (finalAssistantIndex < 0) continue

    const technicalItems: ChatRenderLeaf[] = []
    const finalAnswerItems: ChatRenderLeaf[] = []
    for (
      let turnMessageIndex = messageIndex + 1;
      turnMessageIndex < endIndex;
      turnMessageIndex += 1
    ) {
      const turnMessage = messages[turnMessageIndex]!
      const messageItems = buildMessageRenderItems(
        turnMessage,
        turnMessageIndex,
        messages,
        isRunning,
      )
      if (turnMessageIndex !== finalAssistantIndex) {
        technicalItems.push(...messageItems)
        continue
      }

      for (const item of messageItems) {
        if (
          item.type === "message" ||
          (item.type === "assistant_part" &&
            item.part.type === "text" &&
            item.partIndex === item.canonicalReplyIndex)
        ) {
          finalAnswerItems.push(item)
        } else {
          technicalItems.push(item)
        }
      }
    }

    const finalAssistant = messages[finalAssistantIndex]!
    renderItems.push({
      type: "completed_work",
      key: `${message.id}-worked`,
      durationMs: Math.floor(finalAssistant.durationMs ?? 0),
      items: coalesceAdjacentExplored(technicalItems),
    })
    renderItems.push(...finalAnswerItems)
    messageIndex = endIndex - 1
  }

  const coalesced: ChatRenderItem[] = []
  for (const item of renderItems) {
    const previous = coalesced[coalesced.length - 1]
    if (item.type === "explored" && previous?.type === "explored") {
      coalesced[coalesced.length - 1] =
        coalesceAdjacentExplored([previous, item])[0]!
      continue
    }
    coalesced.push(item)
  }
  return coalesced
}
