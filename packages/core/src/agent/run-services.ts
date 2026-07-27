import type { McpClient } from "../mcp/client.js"
import type { ToolDef } from "../types.js"
import { ParallelAgentManager } from "./parallel.js"
import { BackgroundProcessSupervisor } from "./background-process-supervisor.js"
import { WorkspaceTaskSupervisor } from "../runtime/workspace-task-supervisor.js"
import { OrchestrationRuntime } from "../orchestration/runtime.js"
import {
  WorkspaceToolContributionManager,
  type ToolContributionSnapshot,
} from "../tools/custom/manager.js"

export interface NexusRunServices {
  parallelAgentManager: ParallelAgentManager
  mcpClient?: McpClient
  /**
   * Immutable root-turn MCP/resource capability snapshot. Delegated agents
   * inherit this exact list rather than reading the mutable workspace client.
   */
  mcpToolSnapshot?: readonly ToolDef[]
  backgroundProcesses: BackgroundProcessSupervisor
  workspaceTasks: WorkspaceTaskSupervisor
  /** Workspace-owned loader/runtime for exact-content trusted custom/plugin tools. */
  toolContributionManager: WorkspaceToolContributionManager
  /** Immutable root-turn generation inherited by every delegated agent. */
  toolContributionSnapshot?: ToolContributionSnapshot
  /** Workspace-owned durable task/team/memory projection. */
  orchestrationRuntime: OrchestrationRuntime
  /** Root run is 0; incremented for every delegated-agent generation. */
  subagentDepth: number
  /** Current delegated run id; absent for the root run. */
  subagentId?: string
}

export function createNexusRunServices(input: {
  parallelAgentManager?: ParallelAgentManager
  mcpClient?: McpClient
  mcpToolSnapshot?: readonly ToolDef[]
  backgroundProcesses?: BackgroundProcessSupervisor
  workspaceTasks?: WorkspaceTaskSupervisor
  toolContributionManager?: WorkspaceToolContributionManager
  toolContributionSnapshot?: ToolContributionSnapshot
  orchestrationRuntime?: OrchestrationRuntime
  cwd?: string
  subagentDepth?: number
  subagentId?: string
} = {}): NexusRunServices {
  const orchestrationRuntime =
    input.orchestrationRuntime ??
    input.parallelAgentManager?.orchestrationRuntime ??
    new OrchestrationRuntime(input.cwd ?? process.cwd())
  return {
    parallelAgentManager:
      input.parallelAgentManager ??
      new ParallelAgentManager(orchestrationRuntime),
    ...(input.mcpClient ? { mcpClient: input.mcpClient } : {}),
    ...(input.mcpToolSnapshot
      ? { mcpToolSnapshot: input.mcpToolSnapshot }
      : {}),
    backgroundProcesses:
      input.backgroundProcesses ?? new BackgroundProcessSupervisor(),
    workspaceTasks:
      input.workspaceTasks ?? new WorkspaceTaskSupervisor(),
    toolContributionManager:
      input.toolContributionManager ??
      new WorkspaceToolContributionManager(),
    ...(input.toolContributionSnapshot
      ? { toolContributionSnapshot: input.toolContributionSnapshot }
      : {}),
    orchestrationRuntime,
    subagentDepth: input.subagentDepth ?? 0,
    ...(input.subagentId ? { subagentId: input.subagentId } : {}),
  }
}

/**
 * Drain the workspace-owned live services that are common to every host.
 * Host-specific integrations (MCP, indexers, state databases) remain owned by
 * the host and must be closed after this dependency barrier.
 */
export async function closeNexusRunServices(
  services: NexusRunServices,
): Promise<void> {
  const errors: unknown[] = []
  try {
    await services.parallelAgentManager.shutdown()
  } catch (error) {
    errors.push(error)
  }
  try {
    await services.workspaceTasks.close()
  } catch (error) {
    errors.push(error)
  }
  try {
    await services.backgroundProcesses.close()
  } catch (error) {
    errors.push(error)
  }
  try {
    await services.toolContributionManager?.close()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Failed to close Nexus workspace run services",
    )
  }
}
