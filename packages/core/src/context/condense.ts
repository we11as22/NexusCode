/**
 * Token estimation utilities.
 * Approximation: ~4 chars per token (standard heuristic).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // More accurate: average English word is ~1.3 tokens, average word length ~5 chars
  // Simple approximation: chars / 4
  return Math.ceil(text.length / 4)
}

export function estimateMessagesTokens(messages: Array<{ content: string | unknown[] }>): number {
  let total = 0
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "string") total += estimateTokens(part)
        else if (typeof part === "object" && part !== null) {
          total += estimateTokens(JSON.stringify(part))
        }
      }
    }
  }
  return total
}
