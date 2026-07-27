import type { NexusRunServices } from "../agent/run-services.js"
import type { LLMClient } from "../provider/types.js"
import type { NexusConfig } from "../types.js"
import type { WorkspaceTaskHandle } from "../runtime/workspace-task-supervisor.js"
import { runAutoMemoryDreamIfDue } from "./auto-dream.js"

const AUTO_MEMORY_DREAM_TASK_KEY = "auto-memory-dream"

export function scheduleAutoMemoryDream(options: {
  cwd: string
  config: NexusConfig
  client: LLMClient
  services: NexusRunServices
  run?: typeof runAutoMemoryDreamIfDue
}): WorkspaceTaskHandle | undefined {
  if (
    options.config.memory?.autoDreamEnabled !== true ||
    options.services.subagentDepth !== 0
  ) {
    return undefined
  }
  const run = options.run ?? runAutoMemoryDreamIfDue
  return options.services.workspaceTasks.start(
    AUTO_MEMORY_DREAM_TASK_KEY,
    (signal) =>
      run({
        cwd: options.cwd,
        config: options.config,
        client: options.client,
        signal,
      }),
  )
}
