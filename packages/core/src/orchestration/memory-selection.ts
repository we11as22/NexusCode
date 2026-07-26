import type { MemoryRecord } from "../types.js"
import { retrieveMemories, type RetrievedMemory } from "../memory/index.js"

/**
 * Rank memories for the current task instead of blindly showing the most recent records.
 * This keeps the prompt smaller and closer to OpenClaude-style relevant memory prefetch.
 */
export function selectRelevantMemories(
  memories: MemoryRecord[],
  query: string,
  limit: number,
): RetrievedMemory[] {
  return retrieveMemories({
    memories,
    query,
    limit,
    maxChars: 8_000,
  }).items
}
