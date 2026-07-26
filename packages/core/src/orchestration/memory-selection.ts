import type { MemoryRecord } from "../types.js"
import { retrieveMemories, type RetrievedMemory } from "../memory/index.js"

/**
 * Session-scoped records must never be reachable by guessing their ids from a
 * different session. Task/agent scopes are reserved for delegated runtimes and
 * therefore fail closed unless their persisted metadata binds them to the
 * current session.
 */
export function isMemoryAccessibleFromSession(
  memory: MemoryRecord,
  sessionId: string,
): boolean {
  if (!["session", "task", "agent"].includes(memory.scope)) return true
  return memory.metadata?.sessionId === sessionId
}

export function filterPromptMemoryCandidates(
  memories: MemoryRecord[],
  options: {
    sessionId: string
    includeTeam: boolean
  },
): MemoryRecord[] {
  return memories.filter((memory) => {
    if (!isMemoryAccessibleFromSession(memory, options.sessionId)) return false
    if (memory.scope === "team") return options.includeTeam
    return true
  })
}

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
