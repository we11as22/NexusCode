import type { McpClient } from "../mcp/client.js"
import { ParallelAgentManager } from "./parallel.js"

export interface NexusRunServices {
  parallelAgentManager: ParallelAgentManager
  mcpClient?: McpClient
  /** Root run is 0; incremented for every delegated-agent generation. */
  subagentDepth: number
  /** Current delegated run id; absent for the root run. */
  subagentId?: string
}

export function createNexusRunServices(input: {
  parallelAgentManager?: ParallelAgentManager
  mcpClient?: McpClient
  subagentDepth?: number
  subagentId?: string
} = {}): NexusRunServices {
  return {
    parallelAgentManager:
      input.parallelAgentManager ?? new ParallelAgentManager(),
    ...(input.mcpClient ? { mcpClient: input.mcpClient } : {}),
    subagentDepth: input.subagentDepth ?? 0,
    ...(input.subagentId ? { subagentId: input.subagentId } : {}),
  }
}
