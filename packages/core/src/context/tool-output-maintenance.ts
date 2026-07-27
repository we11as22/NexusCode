import type { NexusRunServices } from "../agent/run-services.js"
import type { WorkspaceTaskHandle } from "../runtime/workspace-task-supervisor.js"
import {
  cleanupExpiredToolOutputArtifacts,
  type ToolOutputMaintenanceOptions,
  type ToolOutputMaintenanceResult,
} from "./truncate.js"

const TOOL_OUTPUT_MAINTENANCE_TASK_KEY = "tool-output-retention"

export function scheduleToolOutputMaintenance(options: {
  cwd: string
  services: NexusRunServices
  onResult?: (result: ToolOutputMaintenanceResult) => void
  run?: (
    cwd: string,
    options: ToolOutputMaintenanceOptions,
  ) => Promise<ToolOutputMaintenanceResult>
}): WorkspaceTaskHandle | undefined {
  if (options.services.subagentDepth !== 0) return undefined
  const run = options.run ?? cleanupExpiredToolOutputArtifacts
  return options.services.workspaceTasks.start(
    TOOL_OUTPUT_MAINTENANCE_TASK_KEY,
    async (signal) => {
      const result = await run(options.cwd, { signal })
      options.onResult?.(result)
    },
  )
}
