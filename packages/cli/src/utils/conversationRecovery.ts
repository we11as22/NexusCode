/**
 * Stub: conversation recovery / load messages from log.
 * Full implementation would read serialized messages from disk and deserialize to Message[].
 */
import type { Message } from '../query.js'
import type { Tool } from '../Tool.js'

export async function loadMessagesFromLog(
  _logPath: string,
  _tools: Tool[],
): Promise<Message[]> {
  return []
}

export function deserializeMessages(
  _messages: unknown[],
  _tools: Tool[],
): Message[] {
  return []
}
