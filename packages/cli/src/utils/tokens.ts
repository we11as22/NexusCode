import { Message } from '../query.js'
import { SYNTHETIC_ASSISTANT_MESSAGES } from './messages.js'

type UsageWithCache = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export function countTokens(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    if (
      message?.type === 'assistant' &&
      'usage' in message.message &&
      !(
        message.message.content[0]?.type === 'text' &&
        SYNTHETIC_ASSISTANT_MESSAGES.has(message.message.content[0].text)
      )
    ) {
      const usage = message.message.usage as UsageWithCache
      return (
        usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        usage.output_tokens
      )
    }
    i--
  }
  return 0
}

export function countCachedTokens(messages: Message[]): number {
  let i = messages.length - 1
  while (i >= 0) {
    const message = messages[i]
    if (message?.type === 'assistant' && 'usage' in message.message) {
      const usage = message.message.usage as UsageWithCache
      return (
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0)
      )
    }
    i--
  }
  return 0
}
