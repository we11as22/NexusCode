import {
  McpClient,
  createMcpResourceTools,
  registerToolContributionSnapshot,
  type AuthorizedNetworkRequest,
  type HostNetworkRequest,
  type McpRemoteRequestAuthorizer,
  type McpResourceContent,
  type McpResourceRef,
  type McpResourceTemplateRef,
  type NexusConfig,
  type NexusRunServices,
  type ToolDef,
  type ToolRegistry,
} from "@nexuscode/core"

interface ServerNetworkAuthorizer {
  authorizeNetworkRequest(
    request: HostNetworkRequest,
  ): Promise<AuthorizedNetworkRequest>
}

interface ServerMcpCapabilityClient {
  getTools(): ToolDef[]
  listResources(
    serverName?: string,
    signal?: AbortSignal,
  ): Promise<McpResourceRef[]>
  listResourceTemplates(
    serverName?: string,
    signal?: AbortSignal,
  ): Promise<McpResourceTemplateRef[]>
  readResource(
    serverName: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<McpResourceContent[]>
}

/**
 * Bind remote MCP transport authorization to the same host boundary used by
 * every other server-side network capability. The transport re-invokes this
 * callback for redirects, so every outbound hop receives an independent
 * public-network authorization.
 */
export function createServerMcpRemoteRequestAuthorizer(
  host: ServerNetworkAuthorizer,
): McpRemoteRequestAuthorizer {
  return ({ url }) =>
    host.authorizeNetworkRequest({
      url,
      purpose: "mcp",
    })
}

/** Create a workspace-owned MCP client with no unmediated remote transport. */
export function createServerMcpClient(
  host: ServerNetworkAuthorizer,
): McpClient {
  return new McpClient({
    remoteRequestAuthorizer: createServerMcpRemoteRequestAuthorizer(host),
  })
}

/**
 * Register the currently configured MCP generation. Stale tools retained by
 * the workspace-owned client are never exposed to this turn, and resource
 * operations are materialized per server so approval grants stay scoped.
 */
export function registerServerMcpCapabilities(
  registry: ToolRegistry,
  client: ServerMcpCapabilityClient,
  allowedServerNames: ReadonlySet<string>,
): readonly ToolDef[] {
  const directTools = client.getTools().filter((tool) => {
    const serverName = tool.integration?.kind === "mcp"
      ? tool.integration.serverName
      : undefined
    return Boolean(serverName && allowedServerNames.has(serverName))
  })
  const resourceTools = createMcpResourceTools(client, allowedServerNames)
  const snapshot = Object.freeze(
    [...directTools, ...resourceTools].map((tool) => Object.freeze(tool)),
  )
  for (const tool of snapshot) {
    registry.registerDynamicOrThrow(
      tool,
      tool.integration?.kind === "mcp" &&
          tool.integration.originalName.startsWith("resources/")
        ? "MCP resource"
        : "MCP",
    )
  }
  return snapshot
}

export interface PrepareServerToolContributionsOptions {
  cwd: string
  config: NexusConfig
  services: NexusRunServices
  registry: ToolRegistry
  onDiagnostic: (message: string) => void
}

/**
 * Materialize executable custom/plugin contributions exactly once for a root
 * turn, register that immutable generation, and attach it to a run-local
 * service view inherited by delegated agents.
 */
export async function prepareServerToolContributions(
  options: PrepareServerToolContributionsOptions,
): Promise<NexusRunServices> {
  const snapshot = await options.services.toolContributionManager.materialize(
    options.cwd,
    options.config,
  )
  for (const diagnostic of snapshot.diagnostics) {
    options.onDiagnostic(
      `[custom tool ${diagnostic.code}] ${diagnostic.sourcePath}: ${diagnostic.message}`,
    )
  }
  registerToolContributionSnapshot(options.registry, snapshot)
  return {
    ...options.services,
    toolContributionSnapshot: snapshot,
  }
}
