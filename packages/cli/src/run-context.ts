import {
  ToolRegistry,
  createAgentRunSnapshotTool,
  createListAgentRunsTool,
  createMcpResourceTools,
  createResumeAgentTool,
  createSpawnAgentOutputTool,
  createSpawnAgentStopTool,
  createSpawnAgentTool,
  createSpawnAgentsParallelTool,
  createTaskCreateBatchTool,
  createTaskResumeTool,
  createTaskSnapshotTool,
  registerToolContributionSnapshot,
  type IHost,
  type McpClient,
  type McpRemoteRequestAuthorizer,
  type NexusConfig,
  type NexusRunServices,
  type ToolContributionDiagnostic,
  type ToolDef,
} from "@nexuscode/core"

export interface CliRunContext {
  toolRegistry: ToolRegistry
  services: NexusRunServices
  toolContributionDiagnostics: readonly ToolContributionDiagnostic[]
}

export interface CreateCliRunContextOptions {
  cwd: string
  /** Authority-hydrated, credential-free workspace configuration. */
  authorityConfig: NexusConfig
  /** Host-finalized configuration used only by executable agent factories. */
  runtimeConfig: NexusConfig
  services: NexusRunServices
  allowedMcpServerNames: ReadonlySet<string>
  remote: boolean
}

export function createCliMcpRemoteRequestAuthorizer(
  host: Pick<IHost, "authorizeNetworkRequest">,
): McpRemoteRequestAuthorizer {
  return ({ url }) =>
    host.authorizeNetworkRequest({ url, purpose: "mcp" })
}

function immutableToolSnapshot(tools: readonly ToolDef[]): readonly ToolDef[] {
  return Object.freeze(tools.map((tool) => Object.freeze(tool)))
}

/**
 * Materialize one immutable root-turn integration view. This prevents a
 * delegated agent from observing MCP servers connected for another config
 * generation and keeps executable custom/plugin code pinned to exact bytes.
 */
export async function createCliRunContext(
  options: CreateCliRunContextOptions,
): Promise<CliRunContext> {
  const registry = new ToolRegistry()
  if (options.remote) {
    return {
      toolRegistry: registry,
      services: {
        ...options.services,
        mcpToolSnapshot: Object.freeze([]),
      },
      toolContributionDiagnostics: Object.freeze([]),
    }
  }

  const manager = options.services.parallelAgentManager
  for (const tool of [
    createSpawnAgentTool(manager, options.runtimeConfig),
    createSpawnAgentsParallelTool(manager, options.runtimeConfig),
    createSpawnAgentOutputTool(manager),
    createSpawnAgentStopTool(manager),
    createListAgentRunsTool(manager),
    createAgentRunSnapshotTool(manager),
    createResumeAgentTool(manager, options.runtimeConfig),
  ]) {
    registry.registerDynamicOrThrow(tool, "manager compatibility")
  }
  for (const tool of [
    createTaskCreateBatchTool(manager, options.runtimeConfig),
    createTaskSnapshotTool(manager),
    createTaskResumeTool(manager, options.runtimeConfig),
  ]) {
    registry.registerBoundBuiltinOrThrow(tool)
  }

  const contributionSnapshot =
    await options.services.toolContributionManager.materialize(
      options.cwd,
      options.authorityConfig,
    )
  registerToolContributionSnapshot(registry, contributionSnapshot)

  const allowedMcpTools = (options.services.mcpClient?.getTools() ?? [])
    .filter((tool) =>
      tool.integration?.kind === "mcp" &&
      options.allowedMcpServerNames.has(tool.integration.serverName)
    )
  const resourceTools = options.services.mcpClient
    ? createMcpResourceTools(
        options.services.mcpClient as McpClient,
        options.allowedMcpServerNames,
      )
    : []
  const mcpToolSnapshot = immutableToolSnapshot([
    ...allowedMcpTools,
    ...resourceTools,
  ])
  for (const tool of mcpToolSnapshot) {
    registry.registerDynamicOrThrow(tool, "MCP/resource snapshot")
  }

  return {
    toolRegistry: registry,
    services: {
      ...options.services,
      toolContributionSnapshot: contributionSnapshot,
      mcpToolSnapshot,
    },
    toolContributionDiagnostics: contributionSnapshot.diagnostics,
  }
}
