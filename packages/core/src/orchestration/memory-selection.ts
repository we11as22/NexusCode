import type { MemoryRecord } from "../types.js"

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "while",
  "have", "will", "your", "about", "there", "their", "what", "when",
  "where", "which", "were", "been", "does", "did", "just", "then",
  "than", "them", "they", "you", "are", "was", "who", "why", "how",
  "can", "could", "should", "would", "want", "need", "make", "made",
  "also", "more", "most", "only", "very", "over", "under", "after",
  "before", "like", "such", "using", "use", "used",
])

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
}

function scoreMemory(memory: MemoryRecord, queryTokens: string[], now: number): number {
  const title = memory.title.toLowerCase()
  const content = memory.content.toLowerCase()
  const metadataText = Object.entries(memory.metadata ?? {})
    .map(([key, value]) => `${key}:${String(value)}`.toLowerCase())
    .join(" ")

  let score = 0
  for (const token of queryTokens) {
    if (title === token) score += 12
    if (title.includes(token)) score += 6
    if (content.includes(token)) score += 3
    if (metadataText.includes(token)) score += 2
  }

  if (memory.scope === "session") score += 2

  const ageHours = Math.max(0, (now - memory.updatedAt) / (1000 * 60 * 60))
  if (ageHours < 1) score += 2
  else if (ageHours < 24) score += 1

  return score
}

/**
 * Rank memories for the current task instead of blindly showing the most recent records.
 * This keeps the prompt smaller and closer to OpenClaude-style relevant memory prefetch.
 */
export function selectRelevantMemories(
  memories: MemoryRecord[],
  query: string,
  limit: number,
): MemoryRecord[] {
  if (memories.length === 0 || limit <= 0) return []
  const queryTokens = tokenize(query)
  const now = Date.now()

  const ranked = memories
    .map((memory) => ({
      memory,
      score: scoreMemory(memory, queryTokens, now),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.memory.updatedAt - a.memory.updatedAt
    })

  const selected = ranked
    .filter((item, index) => item.score > 0 || index < limit)
    .slice(0, limit)
    .map((item) => item.memory)

  const seen = new Set<string>()
  return selected.filter((memory) => {
    const key = `${memory.scope}:${memory.title}:${memory.content}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
