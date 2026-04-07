import type { MessagePart, ReasoningPart, SessionMessage, ToolPart } from "../stores/chat.js"
import { getAssistantDisplaySegments, type ExploredPrefixItem } from "../components/ExploredProgressBlock.js"

const TODO_TOOL_NAMES = new Set(["TodoWrite", "update_todo_list"])
const PLACEHOLDER_TEXT = "Model reasoning is active, but the provider has not streamed visible reasoning text yet."

export type ChatRenderItem =
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

export function buildChatRenderItems(messages: SessionMessage[], isRunning: boolean): ChatRenderItem[] {
  const renderItems: ChatRenderItem[] = []

  messages.forEach((message, messageIndex) => {
    const isComplete = !isRunning || messageIndex < messages.length - 1

    if (message.role !== "assistant" || typeof message.content === "string" || !Array.isArray(message.content)) {
      renderItems.push({
        type: "message",
        key: message.id,
        message,
        messageIndex,
        isComplete,
      })
      return
    }

    const parts = message.content as MessagePart[]
    const canonicalReplyIndex = getCanonicalReplyIndex(parts)
    const segments = getAssistantDisplaySegments(parts)

    segments.forEach((segment, segmentIndex) => {
      if (segment.type === "explored") {
        if (segment.prefixItems.length === 0) return
        const isTrailingSegment = segmentIndex === segments.length - 1
        renderItems.push({
          type: "explored",
          // Stable across streaming appends within the same wave (endIndex grows); avoids Virtuoso remount flicker.
          key: `${message.id}-explored-${segment.startIndex}`,
          prefixItems: segment.prefixItems,
          isRunning: Boolean(isRunning && !isComplete && isTrailingSegment),
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
  })

  return renderItems
}
