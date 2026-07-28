import type { OrchestrationRuntime } from "../orchestration/runtime.js"
import { extractMemoriesFromCompactionSummary } from "../orchestration/memory-extraction.js"
import { appendCompactionSnippetToSessionMemory } from "../session/session-memory.js"
import type { ISession, NexusConfig } from "../types.js"

export interface CompactionProjectionResult {
  readonly memoryRecords: number
  readonly sessionMemoryUpdated: boolean
  readonly diagnostics: readonly string[]
}

/**
 * Project one already-persisted summary into secondary memory stores.
 *
 * The transcript remains authoritative. Projection failures are returned as
 * diagnostics and never turn a durable compaction into a false failure.
 */
export async function projectPersistedCompactionSummary(input: {
  session: ISession
  summaryMessageId: string
  cwd: string
  config: NexusConfig
  orchestrationRuntime: OrchestrationRuntime
  /** Optional storage root override for tests and embedded hosts. */
  sessionMemoryHomeDir?: string
}): Promise<CompactionProjectionResult> {
  const summary = input.session.messages.find(
    (message) =>
      message.id === input.summaryMessageId &&
      message.summary === true &&
      typeof message.content === "string",
  )
  if (!summary || typeof summary.content !== "string") {
    return {
      memoryRecords: 0,
      sessionMemoryUpdated: false,
      diagnostics: [
        `Persisted compaction summary ${input.summaryMessageId} was not found`,
      ],
    }
  }

  const diagnostics: string[] = []
  let memoryRecords = 0
  for (const memory of extractMemoriesFromCompactionSummary(
    summary.content,
    input.session.id,
  )) {
    try {
      await input.orchestrationRuntime.upsertMemoryByTitle(memory)
      memoryRecords += 1
    } catch (error) {
      diagnostics.push(
        `Compaction memory projection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  let sessionMemoryUpdated = false
  if (input.config.memory?.sessionMemoryEnabled !== false) {
    try {
      await appendCompactionSnippetToSessionMemory(
        input.session.id,
        input.cwd,
        summary.content,
        input.config.memory?.sessionMemoryMaxChars ?? 48_000,
        input.sessionMemoryHomeDir,
      )
      sessionMemoryUpdated = true
    } catch (error) {
      diagnostics.push(
        `Compaction session-memory projection failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  return {
    memoryRecords,
    sessionMemoryUpdated,
    diagnostics,
  }
}
