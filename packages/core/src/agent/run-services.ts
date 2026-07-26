import type { McpClient } from "../mcp/client.js"
import { ParallelAgentManager } from "./parallel.js"

export interface NexusRunServices {
  parallelAgentManager: ParallelAgentManager
  mcpClient?: McpClient
}

export function createNexusRunServices(input: {
  parallelAgentManager?: ParallelAgentManager
  mcpClient?: McpClient
} = {}): NexusRunServices {
  return {
    parallelAgentManager:
      input.parallelAgentManager ?? new ParallelAgentManager(),
    ...(input.mcpClient ? { mcpClient: input.mcpClient } : {}),
  }
}

