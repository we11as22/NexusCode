import {
  McpClient,
  createMcpResourceTools,
  registerToolContributionSnapshot,
  type AuthorizedNetworkRequest,
  type HostNetworkRequest,
  type McpRemoteRequestAuthorizer,
  type McpServerConfig,
  type NexusConfig,
  type NexusRunServices,
  type ToolContributionDiagnostic,
  type ToolDef,
  type ToolRegistry,
} from "@nexuscode/core"

interface VsCodeMcpNetworkHost {
  authorizeNetworkRequest(
    request: HostNetworkRequest,
  ): Promise<AuthorizedNetworkRequest>
}

export interface PreparedVsCodeRunIntegrations {
  services: NexusRunServices
  diagnostics: readonly ToolContributionDiagnostic[]
}

/**
 * Route every remote MCP hop through the VS Code host network boundary.
 * McpClient re-runs this callback after redirects, so the returned
 * authorization is never reused for a different destination.
 */
export function createVsCodeMcpRemoteRequestAuthorizer(
  host: VsCodeMcpNetworkHost,
): McpRemoteRequestAuthorizer {
  return ({ url }) =>
    host.authorizeNetworkRequest({
      url,
      purpose: "mcp",
    })
}

/** Create a local-workspace MCP client with no unmediated HTTP transport. */
export function createVsCodeMcpClient(
  host: VsCodeMcpNetworkHost,
): McpClient {
  return new McpClient({
    remoteRequestAuthorizer:
      createVsCodeMcpRemoteRequestAuthorizer(host),
  })
}

/**
 * Probe MCP configuration with the same host-bound network authority as the
 * long-lived client. McpClient.testServers creates and closes one isolated
 * probe per server while retaining these authorization options.
 */
export function testVsCodeMcpServers(
  configs: McpServerConfig[],
  host: VsCodeMcpNetworkHost,
): Promise<Array<{
  name: string
  status: "ok" | "error"
  error?: string
}>> {
  return createVsCodeMcpClient(host).testServers(configs)
}

function immutableToolSnapshot(
  tools: readonly ToolDef[],
): readonly ToolDef[] {
  return Object.freeze(
    tools.map((tool) => Object.freeze(tool)),
  )
}

/**
 * Build the executable integration view exactly once for a local root turn.
 * Custom/plugin modules are materialized from credential-free authority
 * configuration, while MCP ownership comes from explicit provenance rather
 * than normalized tool-name delimiters.
 */
export async function prepareVsCodeRunIntegrations(options: {
  cwd: string
  authorityConfig: NexusConfig
  services: NexusRunServices
  registry: ToolRegistry
  allowedMcpServerNames: ReadonlySet<string>
}): Promise<PreparedVsCodeRunIntegrations> {
  const contributionSnapshot =
    await options.services.toolContributionManager.materialize(
      options.cwd,
      options.authorityConfig,
    )
  registerToolContributionSnapshot(
    options.registry,
    contributionSnapshot,
  )

  const directMcpTools = (
    options.services.mcpClient?.getTools() ?? []
  ).filter(
    (tool) =>
      tool.integration?.kind === "mcp" &&
      options.allowedMcpServerNames.has(
        tool.integration.serverName,
      ),
  )
  const resourceTools = options.services.mcpClient
    ? createMcpResourceTools(
        options.services.mcpClient,
        options.allowedMcpServerNames,
      )
    : []
  const mcpToolSnapshot = immutableToolSnapshot([
    ...directMcpTools,
    ...resourceTools,
  ])
  for (const tool of mcpToolSnapshot) {
    options.registry.registerDynamicOrThrow(
      tool,
      "MCP/resource snapshot",
    )
  }

  return {
    services: {
      ...options.services,
      toolContributionSnapshot: contributionSnapshot,
      mcpToolSnapshot,
    },
    diagnostics: contributionSnapshot.diagnostics,
  }
}
