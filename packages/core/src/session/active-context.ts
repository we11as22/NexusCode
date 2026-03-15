import type { SessionMessage } from "../types.js"

export function getLatestSummaryMessage(messages: SessionMessage[]): SessionMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.summary) return message
  }
  return undefined
}

export function getLatestSummaryIndex(messages: SessionMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.summary) return index
  }
  return -1
}

export function getActiveMessagesAfterLatestSummary(messages: SessionMessage[]): SessionMessage[] {
  const latestSummaryIndex = getLatestSummaryIndex(messages)
  if (latestSummaryIndex === -1) return messages.filter((message) => !message.summary)
  return messages.slice(latestSummaryIndex + 1).filter((message) => !message.summary)
}

export function getMessagesForActiveContext(messages: SessionMessage[]): SessionMessage[] {
  const latestSummaryIndex = getLatestSummaryIndex(messages)
  if (latestSummaryIndex === -1) return messages.filter((message) => !message.summary)
  const latestSummaryMessage = messages[latestSummaryIndex]
  const recentMessages = messages.slice(latestSummaryIndex + 1).filter((message) => !message.summary)
  return latestSummaryMessage ? [latestSummaryMessage, ...recentMessages] : recentMessages
}
