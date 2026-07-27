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
  teamNames: readonly string[] = [],
): boolean {
  if (memory.scope === "team") {
    const teamName = memory.metadata?.teamName
    return (
      typeof teamName === "string" &&
      teamName.length > 0 &&
      teamNames.includes(teamName)
    )
  }
  if (!["session", "task", "agent"].includes(memory.scope)) return true
  return memory.metadata?.sessionId === sessionId
}

export function filterPromptMemoryCandidates(
  memories: MemoryRecord[],
  options: {
    sessionId: string
    includeTeam: boolean
    teamNames: readonly string[]
  },
): MemoryRecord[] {
  return memories.filter((memory) => {
    if (memory.scope === "team" && !options.includeTeam) return false
    return isMemoryAccessibleFromSession(
      memory,
      options.sessionId,
      options.teamNames,
    )
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
