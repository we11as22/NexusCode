import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import type { IHost, McpServerConfig, ToolDef, ToolResult } from "../types.js"
import { normalizeToolSchema } from "../provider/tool-schema.js"
import { createMcpTransport } from "./transport-factory.js"

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_TOOL_TIMEOUT_MS = 60_000
const MAX_TOOL_DESCRIPTION_CHARS = 2_048
const MAX_LIST_PAGES = 100

interface McpProtocolClient {
  connect(transport: Transport): Promise<void>
  close(): Promise<void>
  listTools(params?: { cursor?: string }): Promise<{
    tools: Array<{
      name: string
      description?: string
      inputSchema: Record<string, unknown>
      annotations?: {
        readOnlyHint?: boolean
        destructiveHint?: boolean
        idempotentHint?: boolean
        openWorldHint?: boolean
      }
    }>
    nextCursor?: string
  }>
  callTool(params: {
    name: string
    arguments: Record<string, unknown>
  }): Promise<{
    content?: unknown[]
    structuredContent?: unknown
    isError?: boolean
  }>
  listResources(params?: { cursor?: string }): Promise<{
    resources?: Array<{
      uri: string
      name: string
      description?: string
      mimeType?: string
    }>
    nextCursor?: string
  }>
  listResourceTemplates(params?: { cursor?: string }): Promise<{
    resourceTemplates?: Array<{
      uriTemplate: string
      name: string
      description?: string
      mimeType?: string
    }>
    nextCursor?: string
  }>
  readResource(params: { uri: string }): Promise<{
    contents?: Array<{
      uri: string
      mimeType?: string
      text?: string
      blob?: string
    }>
  }>
  setNotificationHandler(
    schema: typeof ToolListChangedNotificationSchema,
    handler: () => void | Promise<void>,
  ): void
}

type McpDiscoveredTool = Awaited<
  ReturnType<McpProtocolClient["listTools"]>
>["tools"][number]

export interface McpClientOptions {
  startupTimeoutMs?: number
  toolTimeoutMs?: number
  clientFactory?: () => McpProtocolClient
  transportFactory?: (config: McpServerConfig) => Transport
}

export type McpConnectionState =
  | "connecting"
  | "connected"
  | "disabled"
  | "failed"
  | "needs_auth"
  | "disconnected"

export interface McpServerStatus {
  name: string
  state: McpConnectionState
  toolCount: number
  updatedAt: number
  connectedAt?: number
  error?: string
  transport?: "stdio" | "http" | "sse"
}

export interface McpTool {
  name: string
  originalName: string
  description: string
  inputSchema: Record<string, unknown>
  serverName: string
  readOnly: boolean
}

export interface McpResourceRef {
  serverName: string
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpResourceContent {
  serverName: string
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface McpResourceTemplateRef {
  serverName: string
  uriTemplate: string
  name: string
  description?: string
  mimeType?: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAuthenticationError(error: unknown): boolean {
  return /\b(?:401|403|auth(?:entication|orization)?|oauth|token|credential|login)\b/i.test(
    errorMessage(error),
  )
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      void Promise.resolve(onTimeout?.()).catch(() => {})
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function closeProtocolClient(client: McpProtocolClient): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 2_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function transportName(config: McpServerConfig): "stdio" | "http" | "sse" {
  if (config.command) return "stdio"
  const configured = config.transport ?? config.type
  return configured === "sse" ? "sse" : "http"
}

function connectionCandidates(config: McpServerConfig): McpServerConfig[] {
  if (!config.url || config.transport || config.type) return [config]
  return [
    { ...config, transport: "http" },
    { ...config, transport: "sse" },
  ]
}

function boundedDescription(value: string): string {
  if (value.length <= MAX_TOOL_DESCRIPTION_CHARS) return value
  return `${value.slice(0, MAX_TOOL_DESCRIPTION_CHARS - 1)}…`
}

function literalSchema(value: unknown): z.ZodTypeAny {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return z.literal(value)
  }
  return z.unknown()
}

function schemaForNode(node: unknown): z.ZodTypeAny {
  if (!node || typeof node !== "object" || Array.isArray(node)) return z.unknown()
  const schema = node as Record<string, unknown>
  if ("const" in schema) return literalSchema(schema.const)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const schemas = schema.enum.map(literalSchema)
    return schemas.length === 1
      ? schemas[0]!
      : z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }
  const alternatives = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined
  if (alternatives?.length) {
    const schemas = alternatives.map(schemaForNode)
    return schemas.length === 1
      ? schemas[0]!
      : z.union(schemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
  }

  const rawTypes = Array.isArray(schema.type)
    ? schema.type.filter((item): item is string => typeof item === "string")
    : typeof schema.type === "string"
      ? [schema.type]
      : []
  const nullable = rawTypes.includes("null")
  const type = rawTypes.find((item) => item !== "null")
  let result: z.ZodTypeAny
  switch (type) {
    case "string":
      result = z.string()
      break
    case "number":
      result = z.number()
      break
    case "integer":
      result = z.number().int()
      break
    case "boolean":
      result = z.boolean()
      break
    case "null":
      result = z.null()
      break
    case "array":
      result = z.array(schemaForNode(schema.items))
      break
    case "object":
    default: {
      if (type !== "object" && !schema.properties) {
        result = z.unknown()
        break
      }
      const properties =
        schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
          ? schema.properties as Record<string, unknown>
          : {}
      const required = new Set(
        Array.isArray(schema.required)
          ? schema.required.filter((item): item is string => typeof item === "string")
          : [],
      )
      const shape: Record<string, z.ZodTypeAny> = {}
      for (const [key, property] of Object.entries(properties)) {
        let field = schemaForNode(property)
        const description =
          property && typeof property === "object" && !Array.isArray(property)
            ? (property as Record<string, unknown>).description
            : undefined
        if (typeof description === "string") field = field.describe(description)
        shape[key] = required.has(key) ? field : field.optional()
      }
      const object = z.object(shape)
      result = schema.additionalProperties === false ? object.strict() : object.passthrough()
      break
    }
  }
  return nullable ? result.nullable() : result
}

export function buildMcpToolSchema(inputSchema: Record<string, unknown>): z.ZodTypeAny {
  return schemaForNode(normalizeToolSchema(inputSchema))
}

/**
 * Stateful MCP runtime with deterministic reconnects, explicit health, bounded
 * requests, paginated discovery, and list-changed refresh.
 */
export class McpClient {
  private clients = new Map<string, McpProtocolClient>()
  private tools = new Map<string, McpTool>()
  private configs = new Map<string, McpServerConfig>()
  private statuses = new Map<string, McpServerStatus>()
  private refreshes = new Map<string, {
    client: McpProtocolClient
    promise: Promise<void>
  }>()
  private readonly options: Required<Pick<McpClientOptions, "startupTimeoutMs" | "toolTimeoutMs">> &
    Pick<McpClientOptions, "clientFactory" | "transportFactory">

  constructor(options: McpClientOptions = {}) {
    this.options = {
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      toolTimeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      clientFactory: options.clientFactory,
      transportFactory: options.transportFactory,
    }
  }

  private createClient(): McpProtocolClient {
    return this.options.clientFactory?.() ??
      new Client({ name: "nexuscode", version: "0.1.0" }) as unknown as McpProtocolClient
  }

  private createTransport(config: McpServerConfig): Transport {
    return this.options.transportFactory?.(config) ?? createMcpTransport(config)
  }

  private setStatus(
    config: McpServerConfig,
    state: McpConnectionState,
    details: Partial<Omit<McpServerStatus, "name" | "state" | "updatedAt">> = {},
  ): void {
    this.statuses.set(config.name, {
      name: config.name,
      state,
      toolCount: details.toolCount ?? 0,
      updatedAt: Date.now(),
      transport: transportName(config),
      ...details,
    })
  }

  private deleteServerTools(serverName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.serverName === serverName) this.tools.delete(name)
    }
  }

  private async closeServer(serverName: string): Promise<void> {
    const existing = this.clients.get(serverName)
    this.clients.delete(serverName)
    this.deleteServerTools(serverName)
    if (existing) await closeProtocolClient(existing)
  }

  private async listAllTools(client: McpProtocolClient): Promise<McpDiscoveredTool[]> {
    const tools: McpDiscoveredTool[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...response.tools)
      if (!response.nextCursor) return tools
      if (seenCursors.has(response.nextCursor)) {
        throw new Error(`MCP tools/list repeated cursor "${response.nextCursor}"`)
      }
      seenCursors.add(response.nextCursor)
      cursor = response.nextCursor
    }
    throw new Error(`MCP tools/list exceeded ${MAX_LIST_PAGES} pages`)
  }

  private async refreshTools(
    serverName: string,
    expectedClient?: McpProtocolClient,
  ): Promise<void> {
    const client = this.clients.get(serverName)
    if (!client || (expectedClient && expectedClient !== client)) return
    const pending = this.refreshes.get(serverName)
    if (pending?.client === client) return pending.promise
    const refresh = (async () => {
      const config = this.configs.get(serverName)
      if (!config) return
      const discovered = await withTimeout(
        this.listAllTools(client),
        config.startupTimeoutMs ?? this.options.startupTimeoutMs,
        `MCP server "${serverName}" tools/list`,
      )
      if (this.clients.get(serverName) !== client) return
      const replacement = new Map<string, McpTool>()
      for (const tool of discovered) {
        const name = `${serverName}__${tool.name}`
        replacement.set(name, {
          name,
          originalName: tool.name,
          description: boundedDescription(tool.description ?? ""),
          inputSchema: tool.inputSchema,
          serverName,
          readOnly: tool.annotations?.readOnlyHint === true &&
            tool.annotations?.destructiveHint !== true,
        })
      }
      this.deleteServerTools(serverName)
      for (const [name, tool] of replacement) this.tools.set(name, tool)
      const previous = this.statuses.get(serverName)
      this.setStatus(config, "connected", {
        toolCount: replacement.size,
        connectedAt: previous?.connectedAt ?? Date.now(),
      })
    })().finally(() => {
      if (this.refreshes.get(serverName)?.promise === refresh) {
        this.refreshes.delete(serverName)
      }
    })
    this.refreshes.set(serverName, { client, promise: refresh })
    return refresh
  }

  async connect(config: McpServerConfig): Promise<McpServerStatus> {
    await this.closeServer(config.name)
    this.configs.set(config.name, config)
    if (config.enabled === false) {
      this.setStatus(config, "disabled")
      return this.statuses.get(config.name)!
    }
    this.setStatus(config, "connecting")

    let lastError: unknown
    for (const candidate of connectionCandidates(config)) {
      const client = this.createClient()
      let closed = false
      const closeClient = async () => {
        if (closed) return
        closed = true
        await closeProtocolClient(client)
      }
      try {
        const transport = this.createTransport(candidate)
        await withTimeout(
          client.connect(transport),
          config.startupTimeoutMs ?? this.options.startupTimeoutMs,
          `MCP server "${config.name}" startup`,
          closeClient,
        )
        this.clients.set(config.name, client)
        this.configs.set(config.name, candidate)
        await this.refreshTools(config.name, client)
        client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
          await this.refreshTools(config.name, client).catch((error) => {
            this.setStatus(candidate, "connected", {
              error: `Tool refresh failed: ${errorMessage(error)}`,
              toolCount: [...this.tools.values()].filter(
                (tool) => tool.serverName === config.name,
              ).length,
              connectedAt: this.statuses.get(config.name)?.connectedAt,
            })
          })
        })
        return this.statuses.get(config.name)!
      } catch (error) {
        lastError = error
        this.clients.delete(config.name)
        this.deleteServerTools(config.name)
        await closeClient()
      }
    }

    this.configs.set(config.name, config)
    this.setStatus(config, isAuthenticationError(lastError) ? "needs_auth" : "failed", {
      error: errorMessage(lastError),
    })
    return this.statuses.get(config.name)!
  }

  async connectAll(configs: McpServerConfig[]): Promise<Record<string, McpServerStatus>> {
    const unique = new Map<string, McpServerConfig>()
    for (const config of configs) unique.set(config.name, config)
    for (const name of [...this.clients.keys()]) {
      if (!unique.has(name)) {
        await this.closeServer(name)
        this.configs.delete(name)
        this.statuses.delete(name)
      }
    }
    await Promise.all([...unique.values()].map((config) => this.connect(config)))
    return this.getServerStatuses()
  }

  async testServers(
    configs: McpServerConfig[],
  ): Promise<Array<{ name: string; status: "ok" | "error"; error?: string }>> {
    const results: Array<{ name: string; status: "ok" | "error"; error?: string }> = []
    for (const config of configs) {
      if (config.enabled === false) {
        results.push({ name: config.name, status: "ok" })
        continue
      }
      const probe = new McpClient(this.options)
      const status = await probe.connect(config)
      await probe.disconnectAll()
      results.push(
        status.state === "connected"
          ? { name: config.name, status: "ok" }
          : { name: config.name, status: "error", error: status.error ?? status.state },
      )
    }
    return results
  }

  getTools(): ToolDef[] {
    const owner = this
    return Array.from(this.tools.values()).map((mcpTool) => {
      const originalName = mcpTool.originalName ??
        mcpTool.name.slice(`${mcpTool.serverName}__`.length)
      return {
        name: mcpTool.name,
        description: boundedDescription(
          `[MCP: ${mcpTool.serverName}] ${mcpTool.description}`,
        ),
        parameters: buildMcpToolSchema(mcpTool.inputSchema),
        searchHint: `${mcpTool.serverName} MCP tool`,
        shouldDefer: true,
        readOnly: mcpTool.readOnly ?? false,
        integration: {
          kind: "mcp",
          serverName: mcpTool.serverName,
          originalName,
        },
        async execute(args: Record<string, unknown>): Promise<ToolResult> {
          const client = owner.clients.get(mcpTool.serverName)
          const config = owner.configs.get(mcpTool.serverName)
          if (!client) {
            return {
              success: false,
              output: `MCP server "${mcpTool.serverName}" not connected`,
            }
          }
          try {
            const result = await withTimeout(
              client.callTool({ name: originalName, arguments: args }),
              config?.toolTimeoutMs ?? owner.options.toolTimeoutMs,
              `MCP tool "${mcpTool.serverName}/${originalName}"`,
            )
            const parts = Array.isArray(result.content)
              ? result.content.filter(
                  (item): item is Record<string, unknown> =>
                    Boolean(item) && typeof item === "object" && !Array.isArray(item),
                )
              : []
            const lines: string[] = []
            const attachments: NonNullable<ToolResult["attachments"]> = []
            for (const content of parts) {
              const type = typeof content.type === "string" ? content.type : "unknown"
              if (type === "text" && typeof content.text === "string") {
                lines.push(content.text)
              } else if (type === "image" && typeof content.data === "string") {
                const mimeType = typeof content.mimeType === "string"
                  ? content.mimeType
                  : "image/png"
                attachments.push({
                  type: "image",
                  content: content.data,
                  mimeType,
                })
                lines.push(`[MCP image: ${mimeType}]`)
              } else if (type === "resource") {
                const resource = content.resource
                if (resource && typeof resource === "object" && !Array.isArray(resource)) {
                  const value = resource as Record<string, unknown>
                  if (typeof value.text === "string") lines.push(value.text)
                  else if (typeof value.uri === "string") lines.push(`[MCP resource: ${value.uri}]`)
                  else lines.push("[MCP resource]")
                } else {
                  lines.push("[MCP resource]")
                }
              } else if (typeof content.text === "string") {
                lines.push(content.text)
              } else {
                lines.push(`[MCP content type: ${type}]`)
              }
            }
            if (result.structuredContent !== undefined) {
              lines.push(JSON.stringify(result.structuredContent, null, 2))
            }
            return {
              success: result.isError !== true,
              output: lines.join("\n").trim(),
              ...(attachments.length ? { attachments } : {}),
              metadata: {
                mcp: {
                  serverName: mcpTool.serverName,
                  toolName: originalName,
                  content: parts,
                  structuredContent: result.structuredContent,
                },
              },
            }
          } catch (error) {
            if (isAuthenticationError(error)) {
              owner.setStatus(config ?? { name: mcpTool.serverName, command: "unknown" }, "needs_auth", {
                error: errorMessage(error),
                toolCount: [...owner.tools.values()].filter(
                  (tool) => tool.serverName === mcpTool.serverName,
                ).length,
                connectedAt: owner.statuses.get(mcpTool.serverName)?.connectedAt,
              })
            }
            return { success: false, output: `MCP error: ${errorMessage(error)}` }
          }
        },
      }
    })
  }

  /** Backward-compatible coarse state for existing hosts. */
  getStatus(): Record<string, "connected" | "disconnected"> {
    return Object.fromEntries(
      [...this.statuses].map(([name, status]) => [
        name,
        status.state === "connected" ? "connected" : "disconnected",
      ]),
    )
  }

  getServerStatuses(): Record<string, McpServerStatus> {
    return Object.fromEntries(
      [...this.statuses].map(([name, status]) => [name, { ...status }]),
    )
  }

  async disconnectAll(): Promise<void> {
    const names = new Set([...this.clients.keys(), ...this.configs.keys()])
    for (const name of names) {
      await this.closeServer(name)
      const config = this.configs.get(name)
      if (config) this.setStatus(config, "disconnected")
    }
    this.clients.clear()
    this.tools.clear()
    this.configs.clear()
    this.refreshes.clear()
  }

  async listResources(serverName?: string): Promise<McpResourceRef[]> {
    const entries = serverName
      ? [...this.clients.entries()].filter(([name]) => name === serverName)
      : [...this.clients.entries()]
    const all: McpResourceRef[] = []
    for (const [name, client] of entries) {
      const config = this.configs.get(name)
      if (!config) continue
      try {
        const seen = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const response = await withTimeout(
            client.listResources(cursor ? { cursor } : undefined),
            config.toolTimeoutMs ?? this.options.toolTimeoutMs,
            `MCP server "${name}" resources/list`,
          )
          for (const resource of response.resources ?? []) {
            all.push({
              serverName: name,
              uri: resource.uri,
              name: resource.name,
              ...(resource.description ? { description: resource.description } : {}),
              ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
            })
          }
          if (!response.nextCursor) break
          if (seen.has(response.nextCursor)) {
            throw new Error(`MCP resources/list repeated cursor "${response.nextCursor}"`)
          }
          seen.add(response.nextCursor)
          cursor = response.nextCursor
        }
      } catch (error) {
        const previous = this.statuses.get(name)
        this.setStatus(config, "connected", {
          error: `Resource listing failed: ${errorMessage(error)}`,
          toolCount: previous?.toolCount ?? 0,
          connectedAt: previous?.connectedAt,
        })
      }
    }
    return all
  }

  async listResourceTemplates(serverName?: string): Promise<McpResourceTemplateRef[]> {
    const entries = serverName
      ? [...this.clients.entries()].filter(([name]) => name === serverName)
      : [...this.clients.entries()]
    const all: McpResourceTemplateRef[] = []
    for (const [name, client] of entries) {
      const config = this.configs.get(name)
      if (!config) continue
      try {
        const seen = new Set<string>()
        let cursor: string | undefined
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const response = await withTimeout(
            client.listResourceTemplates(cursor ? { cursor } : undefined),
            config.toolTimeoutMs ?? this.options.toolTimeoutMs,
            `MCP server "${name}" resources/templates/list`,
          )
          for (const template of response.resourceTemplates ?? []) {
            all.push({
              serverName: name,
              uriTemplate: template.uriTemplate,
              name: template.name,
              ...(template.description ? { description: template.description } : {}),
              ...(template.mimeType ? { mimeType: template.mimeType } : {}),
            })
          }
          if (!response.nextCursor) break
          if (seen.has(response.nextCursor)) {
            throw new Error(
              `MCP resources/templates/list repeated cursor "${response.nextCursor}"`,
            )
          }
          seen.add(response.nextCursor)
          cursor = response.nextCursor
        }
      } catch (error) {
        const previous = this.statuses.get(name)
        this.setStatus(config, "connected", {
          error: `Resource template listing failed: ${errorMessage(error)}`,
          toolCount: previous?.toolCount ?? 0,
          connectedAt: previous?.connectedAt,
        })
      }
    }
    return all
  }

  async readResource(serverName: string, uri: string): Promise<McpResourceContent[]> {
    const client = this.clients.get(serverName)
    const config = this.configs.get(serverName)
    if (!client || !config) {
      throw new Error(`MCP server "${serverName}" not connected`)
    }
    const response = await withTimeout(
      client.readResource({ uri }),
      config.toolTimeoutMs ?? this.options.toolTimeoutMs,
      `MCP server "${serverName}" resources/read`,
    )
    return (response.contents ?? []).map((item) => ({
      serverName,
      uri: item.uri,
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      ...(typeof item.text === "string" ? { text: item.text } : {}),
      ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
    }))
  }

  async authenticate(
    serverName: string,
    host?: IHost,
  ): Promise<{ success: boolean; message: string }> {
    const config = this.configs.get(serverName)
    if (!config) {
      return { success: false, message: `MCP server "${serverName}" is not configured` }
    }
    const auth = config.auth
    if (!auth) {
      return {
        success: false,
        message: `MCP server "${serverName}" does not declare an auth handoff in NexusCode config.`,
      }
    }
    if (host?.requestMcpAuthentication) {
      const result = await host.requestMcpAuthentication({
        server: serverName,
        ...(auth.message ? { message: auth.message } : {}),
        ...(auth.startUrl ? { startUrl: auth.startUrl } : {}),
      })
      if (!result.success) return result
      const status = await this.connect(config)
      return status.state === "connected"
        ? {
            success: true,
            message: `${result.message}\nMCP server "${serverName}" reconnected successfully.`,
          }
        : {
            success: false,
            message: `${result.message}\nReconnect failed: ${status.error ?? status.state}`,
          }
    }
    if (auth.startUrl) {
      return {
        success: true,
        message: `${auth.message?.trim() || `Open the following URL to authenticate ${serverName}:`}\n${auth.startUrl}`,
      }
    }
    return {
      success: false,
      message: auth.message?.trim() ||
        `MCP server "${serverName}" requires manual authentication.`,
    }
  }
}

/** Standalone test of MCP server configs (does not keep connections). */
export async function testMcpServers(
  configs: McpServerConfig[],
): Promise<Array<{ name: string; status: "ok" | "error"; error?: string }>> {
  return new McpClient().testServers(configs)
}
