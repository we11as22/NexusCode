import type { NexusRunServices } from "../agent/run-services.js"
import type { LLMClient } from "../provider/types.js"
import type { WorkspaceTaskHandle } from "../runtime/workspace-task-supervisor.js"
import { refreshSessionMemoryFile } from "../session/session-memory.js"
import type { ISession, NexusConfig } from "../types.js"

const SESSION_MEMORY_REFRESH_TASK_PREFIX = "session-memory-refresh:"

/**
 * Own session-memory refreshes at workspace scope.
 *
 * The supervisor deduplicates adjacent turns for the same session and aborts
 * the model request before workspace integrations are disposed. Ephemeral
 * delegated sessions already persist their transcript snapshot and must not
 * leak standalone session-memory files.
 */
export function scheduleSessionMemoryRefresh(options: {
  session: ISession
  client: LLMClient
  cwd: string
  config: NexusConfig
  services: NexusRunServices
  run?: typeof refreshSessionMemoryFile
}): WorkspaceTaskHandle | undefined {
  if (
    options.config.memory?.sessionMemoryEnabled === false ||
    options.services.subagentDepth !== 0
  ) {
    return undefined
  }
  const run = options.run ?? refreshSessionMemoryFile
  return options.services.workspaceTasks.start(
    `${SESSION_MEMORY_REFRESH_TASK_PREFIX}${options.session.id}`,
    (signal) =>
      run({
        session: options.session,
        client: options.client,
        cwd: options.cwd,
        config: options.config,
        signal,
      }),
  )
}
