import {
  RemoteMcpPromptResolveResponseSchema,
  buildRemoteMcpPromptCatalog,
  renderMcpPromptResult,
  type McpClient,
  type McpPromptRef,
  type McpServerConfig,
  type NexusConfig,
  type RemoteMcpPromptCatalog,
  type RemoteMcpPromptResolveRequest,
  type RemoteMcpPromptResolveResponse,
  type WorkspaceRuntime,
} from "@nexuscode/core"

import {
  loadServerWorkspaceConfig,
  resolveServerMcpServers,
} from "./run-session.js"

interface WorkspaceMcpPromptPort {
  ensureConnected(
    configs: McpServerConfig[],
  ): ReturnType<McpClient["ensureConnected"]>
  getPromptCatalog(serverName?: string): McpPromptRef[]
  getPrompt: McpClient["getPrompt"]
}

export interface ServerMcpPromptServiceOptions {
  loadConfig?: (cwd: string) => Promise<NexusConfig>
  resolveServers?: (
    cwd: string,
    config: NexusConfig,
  ) => Promise<{ servers: McpServerConfig[] }>
}

export class McpPromptRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "McpPromptRuntimeUnavailableError"
  }
}

export class McpPromptCatalogConflictError extends Error {
  readonly currentRevision: string

  constructor(currentRevision: string) {
    super("The MCP prompt catalog changed; refresh it before resolving a prompt")
    this.name = "McpPromptCatalogConflictError"
    this.currentRevision = currentRevision
  }
}

export class McpPromptNotFoundError extends Error {
  constructor() {
    super("The requested MCP prompt is not available in this workspace")
    this.name = "McpPromptNotFoundError"
  }
}

function mcpPort(runtime: WorkspaceRuntime): WorkspaceMcpPromptPort {
  const value = runtime.services.mcp
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Partial<WorkspaceMcpPromptPort>).ensureConnected !== "function" ||
    typeof (value as Partial<WorkspaceMcpPromptPort>).getPromptCatalog !== "function" ||
    typeof (value as Partial<WorkspaceMcpPromptPort>).getPrompt !== "function"
  ) {
    throw new McpPromptRuntimeUnavailableError(
      "The workspace runtime does not expose MCP prompts",
    )
  }
  return value as WorkspaceMcpPromptPort
}

async function connectedCatalog(
  runtime: WorkspaceRuntime,
  cwd: string,
  options: ServerMcpPromptServiceOptions,
): Promise<{
  mcp: WorkspaceMcpPromptPort
  catalog: RemoteMcpPromptCatalog
}> {
  const mcp = mcpPort(runtime)
  const loadConfig = options.loadConfig ?? loadServerWorkspaceConfig
  const resolveServers = options.resolveServers ?? resolveServerMcpServers
  const config = await loadConfig(cwd)
  const resolved = await resolveServers(cwd, config)
  await mcp.ensureConnected(resolved.servers)
  const allowedServers = new Set(
    resolved.servers.map((server) => server.name),
  )
  const prompts = mcp.getPromptCatalog().filter((prompt) =>
    allowedServers.has(prompt.serverName)
  )
  return {
    mcp,
    catalog: buildRemoteMcpPromptCatalog(prompts),
  }
}

export async function getServerMcpPromptCatalog(
  runtime: WorkspaceRuntime,
  cwd: string,
  options: ServerMcpPromptServiceOptions = {},
): Promise<RemoteMcpPromptCatalog> {
  return (await connectedCatalog(runtime, cwd, options)).catalog
}

export async function resolveServerMcpPrompt(
  runtime: WorkspaceRuntime,
  cwd: string,
  request: RemoteMcpPromptResolveRequest,
  signal?: AbortSignal,
  options: ServerMcpPromptServiceOptions = {},
): Promise<RemoteMcpPromptResolveResponse> {
  const { mcp, catalog } = await connectedCatalog(runtime, cwd, options)
  if (request.revision !== catalog.revision) {
    throw new McpPromptCatalogConflictError(catalog.revision)
  }
  const command = catalog.commands.find(
    (candidate) => candidate.promptId === request.promptId,
  )
  if (!command) throw new McpPromptNotFoundError()
  const result = await mcp.getPrompt(
    command.serverName,
    command.name,
    request.arguments,
    signal,
  )
  const text = renderMcpPromptResult(result).trim()
  return RemoteMcpPromptResolveResponseSchema.parse({
    input: [{
      type: "text",
      text:
        text ||
        `MCP prompt ${command.serverName}/${command.name} returned no content.`,
    }],
  })
}
