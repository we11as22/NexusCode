/**
 * Token estimation utilities.
 * Approximation: ~4 chars per token (standard heuristic).
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // ASCII prose/code averages roughly four characters per token. Treat each
  // non-ASCII code point as at least one token so CJK and emoji cannot make us
  // compact only after the provider's hard context limit has already fired.
  let ascii = 0
  let nonAscii = 0
  for (const codePoint of text) {
    if (codePoint.codePointAt(0)! <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / 4 + nonAscii)
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
