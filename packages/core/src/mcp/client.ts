import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  PromptListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { IHost, McpServerConfig, ToolDef, ToolResult } from "../types.js"
import {
  MAX_LIST_PAGES,
  MAX_PROMPT_ARGUMENTS,
  MAX_PROMPT_BINARY_BYTES,
  MAX_PROMPT_MESSAGES,
  MAX_PROMPT_TEXT_CHARS,
  MAX_PROMPT_TOTAL_BINARY_BYTES,
  MAX_PROMPTS_PER_SERVER,
  MAX_RESOURCE_BLOB_BYTES,
  MAX_RESOURCE_CONTENT_ITEMS,
  MAX_RESOURCE_TEXT_CHARS,
  MAX_RESOURCE_TOTAL_BLOB_BYTES,
  MAX_RESOURCES_PER_SERVER,
  MAX_TOOL_NAME_CHARS,
  MAX_TOOLS_PER_SERVER,
  McpPayloadLimitError,
  approximateBase64Bytes,
  assertMcpToolSchemaBounds,
  boundedDescription,
  boundedResourceField,
  buildMcpToolSchema,
  formatMcpToolResult,
} from "./payload-limits.js"
import {
  closeProtocolClient,
  errorMessage,
  isAuthenticationError,
  withAbortableTimeout,
  type McpDiscoveredTool,
  type McpProtocolClient,
} from "./protocol-client.js"
import { callableMcpToolName } from "./tool-name.js"
import { createMcpTransport } from "./transport-factory.js"
import type {
  McpClientOptions,
  McpConnectionState,
  McpPromptContent,
  McpPromptRef,
  McpPromptResult,
  McpResourceContent,
  McpResourceRef,
  McpResourceTemplateRef,
  McpServerStatus,
  McpTool,
} from "./types.js"
import { parseMcpHttpUrl } from "./url.js"

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000
const DEFAULT_TOOL_TIMEOUT_MS = 60_000
const DEFAULT_RECONNECT_ATTEMPTS = 3
const DEFAULT_RECONNECT_BASE_DELAY_MS = 500
const FAILED_ENSURE_RETRY_COOLDOWN_MS = 30_000

function stableConfigValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableConfigValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableConfigValue(item)]),
    )
  }
  return value
}

function configFingerprint(config: McpServerConfig): string {
  return JSON.stringify(stableConfigValue(config))
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

/**
 * Stateful MCP runtime with deterministic reconnects, explicit health, bounded
 * requests, paginated discovery, and list-changed refresh.
 */
export class McpClient {
  private clients = new Map<string, McpProtocolClient>()
  private serverLifecycles = new Map<string, AbortController>()
  private tools = new Map<string, McpTool>()
  private prompts = new Map<string, McpPromptRef>()
  private configs = new Map<string, McpServerConfig>()
  private statuses = new Map<string, McpServerStatus>()
  private refreshes = new Map<string, {
    client: McpProtocolClient
    promise: Promise<void>
  }>()
  private promptRefreshes = new Map<string, {
    client: McpProtocolClient
    promise: Promise<void>
  }>()
  private reconnects = new Map<string, Promise<void>>()
  private ensureConnects = new Map<string, {
    fingerprint: string
    promise: Promise<McpServerStatus>
  }>()
  private configFingerprints = new Map<string, string>()
  private serverEpochs = new Map<string, number>()
  private lifecycleEpoch = 0
  private readonly options: Required<Pick<
    McpClientOptions,
    "startupTimeoutMs" | "toolTimeoutMs" | "reconnectAttempts" | "reconnectBaseDelayMs"
  >> &
    Pick<
      McpClientOptions,
      "clientFactory" | "transportFactory" | "remoteRequestAuthorizer"
    >

  constructor(options: McpClientOptions = {}) {
    this.options = {
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      toolTimeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      reconnectAttempts: Math.max(0, options.reconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS),
      reconnectBaseDelayMs: Math.max(
        1,
        options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
      ),
      clientFactory: options.clientFactory,
      transportFactory: options.transportFactory,
      remoteRequestAuthorizer: options.remoteRequestAuthorizer,
    }
  }

  private createClient(): McpProtocolClient {
    return this.options.clientFactory?.() ??
      new Client({ name: "nexuscode", version: "0.1.0" }) as unknown as McpProtocolClient
  }

  private createTransport(config: McpServerConfig): Transport {
    if (config.url && !this.options.remoteRequestAuthorizer) {
      throw new Error(
        `MCP server "${config.name}": remote transport requires an injected network authorizer`,
      )
    }
    return this.options.transportFactory?.(config) ?? createMcpTransport(config, {
      remoteRequestAuthorizer: this.options.remoteRequestAuthorizer,
    })
  }

  private nextServerEpoch(serverName: string): number {
    const next = (this.serverEpochs.get(serverName) ?? 0) + 1
    this.serverEpochs.set(serverName, next)
    return next
  }

  private isCurrentServerEpoch(serverName: string, epoch: number): boolean {
    return this.serverEpochs.get(serverName) === epoch
  }

  private currentStatus(config: McpServerConfig): McpServerStatus {
    return this.statuses.get(config.name) ?? {
      name: config.name,
      state: "disconnected",
      toolCount: 0,
      updatedAt: Date.now(),
      transport: transportName(config),
    }
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

  private promptKey(serverName: string, promptName: string): string {
    return `${serverName}\0${promptName}`
  }

  private deleteServerPrompts(serverName: string): void {
    for (const [key, prompt] of this.prompts) {
      if (prompt.serverName === serverName) this.prompts.delete(key)
    }
  }

  private abortServerRequests(serverName: string, reason: Error): void {
    const lifecycle = this.serverLifecycles.get(serverName)
    this.serverLifecycles.delete(serverName)
    if (lifecycle && !lifecycle.signal.aborted) lifecycle.abort(reason)
  }

  private async closeServer(serverName: string): Promise<void> {
    const existing = this.clients.get(serverName)
    this.clients.delete(serverName)
    this.abortServerRequests(
      serverName,
      new Error(`MCP server "${serverName}" disconnected`),
    )
    this.deleteServerTools(serverName)
    this.deleteServerPrompts(serverName)
    if (existing) await closeProtocolClient(existing)
  }

  private handleTransportLoss(
    serverName: string,
    client: McpProtocolClient,
    error?: unknown,
  ): void {
    if (this.clients.get(serverName) !== client) return
    const config = this.configs.get(serverName)
    if (!config || config.enabled === false) return

    this.clients.delete(serverName)
    this.abortServerRequests(
      serverName,
      new Error(`MCP server "${serverName}" transport lost`),
    )
    this.deleteServerTools(serverName)
    this.deleteServerPrompts(serverName)
    this.setStatus(config, "disconnected", {
      error: error ? `Transport lost: ${errorMessage(error)}` : "Transport closed",
    })
    void closeProtocolClient(client)

    if (this.options.reconnectAttempts === 0 || this.reconnects.has(serverName)) {
      return
    }
    const epoch = this.lifecycleEpoch
    const serverEpoch = this.serverEpochs.get(serverName) ?? 0
    const reconnect = (async () => {
      for (let attempt = 0; attempt < this.options.reconnectAttempts; attempt += 1) {
        const delayMs = Math.min(
          30_000,
          this.options.reconnectBaseDelayMs * 2 ** attempt,
        )
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs)
          timer.unref?.()
        })
        if (
          this.lifecycleEpoch !== epoch ||
          !this.isCurrentServerEpoch(serverName, serverEpoch)
        ) return
        const current = this.configs.get(serverName)
        if (!current || current.enabled === false) return
        const status = await this.connectAtEpoch(current, serverEpoch)
        if (status.state === "connected") return
      }
    })().finally(() => {
      if (this.reconnects.get(serverName) === reconnect) {
        this.reconnects.delete(serverName)
      }
    })
    this.reconnects.set(serverName, reconnect)
  }

  private async listAllTools(
    client: McpProtocolClient,
    signal?: AbortSignal,
  ): Promise<McpDiscoveredTool[]> {
    const tools: McpDiscoveredTool[] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = await client.listTools(
        cursor ? { cursor } : undefined,
        signal ? { signal } : undefined,
      )
      if (tools.length + response.tools.length > MAX_TOOLS_PER_SERVER) {
        throw new McpPayloadLimitError(
          `MCP tools/list exceeded ${MAX_TOOLS_PER_SERVER} tools`,
        )
      }
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
      const discovered = await withAbortableTimeout(
        (signal) => this.listAllTools(client, signal),
        config.startupTimeoutMs ?? this.options.startupTimeoutMs,
        `MCP server "${serverName}" tools/list`,
        this.serverLifecycles.get(serverName)?.signal,
      )
      if (this.clients.get(serverName) !== client) return
      const replacement = new Map<string, McpTool>()
      const originalNames = new Set<string>()
      for (const tool of discovered) {
        if (
          typeof tool.name !== "string" ||
          tool.name.trim().length === 0 ||
          tool.name.length > MAX_TOOL_NAME_CHARS
        ) {
          throw new McpPayloadLimitError(
            `MCP server "${serverName}" returned an invalid or oversized tool name`,
          )
        }
        if (originalNames.has(tool.name)) {
          throw new Error(
            `MCP server "${serverName}" returned duplicate tool name "${tool.name}"`,
          )
        }
        originalNames.add(tool.name)
        assertMcpToolSchemaBounds(tool.inputSchema, tool.name)
        const name = callableMcpToolName(serverName, tool.name)
        if (replacement.has(name)) {
          throw new Error(
            `MCP server "${serverName}" returned tool names that collide after provider-safe normalization`,
          )
        }
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

  private async listAllPrompts(
    client: McpProtocolClient,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<McpProtocolClient["listPrompts"]>>["prompts"]> {
    const prompts: Awaited<
      ReturnType<McpProtocolClient["listPrompts"]>
    >["prompts"] = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await client.listPrompts(
        cursor ? { cursor } : undefined,
        signal ? { signal } : undefined,
      )
      if (prompts.length + response.prompts.length > MAX_PROMPTS_PER_SERVER) {
        throw new McpPayloadLimitError(
          `MCP prompts/list exceeded ${MAX_PROMPTS_PER_SERVER} prompts`,
        )
      }
      prompts.push(...response.prompts)
      if (!response.nextCursor) return prompts
      if (seenCursors.has(response.nextCursor)) {
        throw new Error(
          `MCP prompts/list repeated cursor "${response.nextCursor}"`,
        )
      }
      seenCursors.add(response.nextCursor)
      cursor = response.nextCursor
    }
    throw new Error(`MCP prompts/list exceeded ${MAX_LIST_PAGES} pages`)
  }

  private async refreshPrompts(
    serverName: string,
    expectedClient?: McpProtocolClient,
  ): Promise<void> {
    const client = this.clients.get(serverName)
    if (!client || (expectedClient && expectedClient !== client)) return
    if (!client.getServerCapabilities?.()?.prompts) {
      this.deleteServerPrompts(serverName)
      return
    }
    const pending = this.promptRefreshes.get(serverName)
    if (pending?.client === client) return pending.promise
    const refresh = (async () => {
      const config = this.configs.get(serverName)
      if (!config) return
      const discovered = await withAbortableTimeout(
        (signal) => this.listAllPrompts(client, signal),
        config.startupTimeoutMs ?? this.options.startupTimeoutMs,
        `MCP server "${serverName}" prompts/list`,
        this.serverLifecycles.get(serverName)?.signal,
      )
      if (this.clients.get(serverName) !== client) return
      const replacement = new Map<string, McpPromptRef>()
      for (const prompt of discovered) {
        if (
          typeof prompt.name !== "string" ||
          prompt.name.trim().length === 0 ||
          prompt.name.length > MAX_TOOL_NAME_CHARS
        ) {
          throw new McpPayloadLimitError(
            `MCP server "${serverName}" returned an invalid or oversized prompt name`,
          )
        }
        const rawArguments = prompt.arguments ?? []
        if (rawArguments.length > MAX_PROMPT_ARGUMENTS) {
          throw new McpPayloadLimitError(
            `MCP prompt "${prompt.name}" exceeded ${MAX_PROMPT_ARGUMENTS} arguments`,
          )
        }
        const argumentNames = new Set<string>()
        const argumentsList = rawArguments.map((argument) => {
          const name = boundedResourceField(
            argument.name,
            `MCP prompt "${prompt.name}" argument name`,
          )
          if (!name.trim() || argumentNames.has(name)) {
            throw new McpPayloadLimitError(
              `MCP prompt "${prompt.name}" returned an empty or duplicate argument`,
            )
          }
          argumentNames.add(name)
          return Object.freeze({
            name,
            ...(argument.description
              ? { description: boundedDescription(argument.description) }
              : {}),
            required: argument.required === true,
          })
        })
        const ref: McpPromptRef = Object.freeze({
          serverName,
          name: prompt.name,
          ...(prompt.title
            ? {
                title: boundedResourceField(
                  prompt.title,
                  `MCP prompt "${prompt.name}" title`,
                ),
              }
            : {}),
          ...(prompt.description
            ? { description: boundedDescription(prompt.description) }
            : {}),
          arguments: Object.freeze(argumentsList),
        })
        const key = this.promptKey(serverName, prompt.name)
        if (replacement.has(key)) {
          throw new McpPayloadLimitError(
            `MCP server "${serverName}" returned duplicate prompt "${prompt.name}"`,
          )
        }
        replacement.set(key, ref)
      }
      this.deleteServerPrompts(serverName)
      for (const [key, prompt] of replacement) this.prompts.set(key, prompt)
    })().finally(() => {
      if (this.promptRefreshes.get(serverName)?.promise === refresh) {
        this.promptRefreshes.delete(serverName)
      }
    })
    this.promptRefreshes.set(serverName, { client, promise: refresh })
    return refresh
  }

  async connect(config: McpServerConfig): Promise<McpServerStatus> {
    this.configFingerprints.set(config.name, configFingerprint(config))
    const epoch = this.nextServerEpoch(config.name)
    // An explicit connect supersedes a scheduled reconnect. The old timer may
    // still wake, but its server epoch prevents it from touching live state.
    this.reconnects.delete(config.name)
    return this.connectAtEpoch(config, epoch)
  }

  /**
   * Additively reconcile a workspace-owned MCP runtime.
   *
   * Unlike connectAll(), servers omitted by one turn are retained for other
   * concurrent sessions and background agents. Callers still filter the
   * exposed ToolDef snapshot by the current turn's allowed server names.
   */
  async ensureConnected(
    configs: McpServerConfig[],
  ): Promise<Record<string, McpServerStatus>> {
    const unique = new Map<string, McpServerConfig>()
    for (const config of configs) unique.set(config.name, config)
    await Promise.all([...unique.values()].map(async (config) => {
      const fingerprint = configFingerprint(config)
      const pending = this.ensureConnects.get(config.name)
      if (pending?.fingerprint === fingerprint) {
        await pending.promise
        return
      }
      const status = this.statuses.get(config.name)
      const unchanged =
        this.configFingerprints.get(config.name) === fingerprint
      if (
        unchanged &&
        status &&
        (
          status.state === "connected" ||
          status.state === "disabled" ||
          status.state === "needs_auth" ||
          (
            status.state === "failed" &&
            Date.now() - status.updatedAt < FAILED_ENSURE_RETRY_COOLDOWN_MS
          )
        )
      ) {
        return
      }
      const promise = this.connect(config)
      this.ensureConnects.set(config.name, { fingerprint, promise })
      try {
        await promise
      } finally {
        if (this.ensureConnects.get(config.name)?.promise === promise) {
          this.ensureConnects.delete(config.name)
        }
      }
    }))
    const result: Record<string, McpServerStatus> = {}
    for (const name of unique.keys()) {
      const status = this.statuses.get(name)
      if (status) result[name] = { ...status }
    }
    return result
  }

  private async connectAtEpoch(
    config: McpServerConfig,
    epoch: number,
  ): Promise<McpServerStatus> {
    if (!this.isCurrentServerEpoch(config.name, epoch)) {
      return this.currentStatus(config)
    }
    await this.closeServer(config.name)
    if (!this.isCurrentServerEpoch(config.name, epoch)) {
      return this.currentStatus(config)
    }
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
        await withAbortableTimeout(
          (signal) => client.connect(transport, { signal }),
          config.startupTimeoutMs ?? this.options.startupTimeoutMs,
          `MCP server "${config.name}" startup`,
          undefined,
          closeClient,
        )
        if (!this.isCurrentServerEpoch(config.name, epoch)) {
          await closeClient()
          return this.currentStatus(config)
        }
        this.clients.set(config.name, client)
        this.serverLifecycles.set(config.name, new AbortController())
        this.configs.set(config.name, candidate)
        await this.refreshTools(config.name, client)
        await this.refreshPrompts(config.name, client)
        if (
          !this.isCurrentServerEpoch(config.name, epoch) ||
          this.clients.get(config.name) !== client
        ) {
          await closeClient()
          return this.currentStatus(config)
        }
        client.onclose = () => {
          this.handleTransportLoss(config.name, client)
        }
        client.onerror = (error) => {
          this.handleTransportLoss(config.name, client, error)
        }
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
        if (client.getServerCapabilities?.()?.prompts?.listChanged) {
          client.setNotificationHandler(
            PromptListChangedNotificationSchema,
            async () => {
              await this.refreshPrompts(config.name, client).catch((error) => {
                this.setStatus(candidate, "connected", {
                  error: `Prompt refresh failed: ${errorMessage(error)}`,
                  toolCount: [...this.tools.values()].filter(
                    (tool) => tool.serverName === config.name,
                  ).length,
                  connectedAt:
                    this.statuses.get(config.name)?.connectedAt,
                })
              })
            },
          )
        }
        return this.statuses.get(config.name)!
      } catch (error) {
        lastError = error
        if (this.isCurrentServerEpoch(config.name, epoch)) {
          if (this.clients.get(config.name) === client) {
            this.clients.delete(config.name)
            this.abortServerRequests(
              config.name,
              new Error(`MCP server "${config.name}" connection failed`),
            )
            this.deleteServerTools(config.name)
            this.deleteServerPrompts(config.name)
          }
        }
        await closeClient()
        if (!this.isCurrentServerEpoch(config.name, epoch)) {
          return this.currentStatus(config)
        }
      }
    }

    if (!this.isCurrentServerEpoch(config.name, epoch)) {
      return this.currentStatus(config)
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
    const trackedNames = new Set([
      ...this.clients.keys(),
      ...this.configs.keys(),
      ...this.statuses.keys(),
      ...this.serverEpochs.keys(),
    ])
    for (const name of trackedNames) {
      if (!unique.has(name)) {
        const removalEpoch = this.nextServerEpoch(name)
        this.reconnects.delete(name)
        await this.closeServer(name)
        // A newer explicit connect is authoritative and must not have its
        // config/status deleted by an older connectAll removal.
        if (!this.isCurrentServerEpoch(name, removalEpoch)) continue
        this.configs.delete(name)
        this.statuses.delete(name)
        this.configFingerprints.delete(name)
        this.ensureConnects.delete(name)
        this.refreshes.delete(name)
        this.promptRefreshes.delete(name)
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
        async execute(args: Record<string, unknown>, context): Promise<ToolResult> {
          const client = owner.clients.get(mcpTool.serverName)
          const config = owner.configs.get(mcpTool.serverName)
          if (!client) {
            return {
              success: false,
              output: `MCP server "${mcpTool.serverName}" not connected`,
            }
          }
          try {
            const result = await withAbortableTimeout(
              (signal) => client.callTool(
                { name: originalName, arguments: args },
                undefined,
                { signal },
              ),
              config?.toolTimeoutMs ?? owner.options.toolTimeoutMs,
              `MCP tool "${mcpTool.serverName}/${originalName}"`,
              [
                context?.signal,
                owner.serverLifecycles.get(mcpTool.serverName)?.signal,
              ].filter((signal): signal is AbortSignal => Boolean(signal)),
              (reason) => {
                owner.handleTransportLoss(mcpTool.serverName, client, reason)
              },
            )
            return formatMcpToolResult(
              result,
              mcpTool.serverName,
              originalName,
            )
          } catch (error) {
            if (error instanceof McpPayloadLimitError) {
              owner.handleTransportLoss(mcpTool.serverName, client, error)
            }
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

  getPromptCatalog(serverName?: string): McpPromptRef[] {
    return [...this.prompts.values()]
      .filter((prompt) => !serverName || prompt.serverName === serverName)
      .map((prompt) => ({
        ...prompt,
        arguments: prompt.arguments.map((argument) => ({ ...argument })),
      }))
      .sort((left, right) =>
        left.serverName.localeCompare(right.serverName) ||
        left.name.localeCompare(right.name)
      )
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    args: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<McpPromptResult> {
    const client = this.clients.get(serverName)
    const config = this.configs.get(serverName)
    if (!client || !config) {
      throw new Error(`MCP server "${serverName}" not connected`)
    }
    let prompt = this.prompts.get(this.promptKey(serverName, promptName))
    if (!prompt) {
      await this.refreshPrompts(serverName, client)
      prompt = this.prompts.get(this.promptKey(serverName, promptName))
    }
    if (!prompt) {
      throw new Error(
        `MCP prompt "${serverName}/${promptName}" was not found`,
      )
    }
    const definitions = new Map(
      prompt.arguments.map((argument) => [argument.name, argument]),
    )
    for (const [name, value] of Object.entries(args)) {
      if (!definitions.has(name)) {
        throw new Error(
          `Unknown argument "${name}" for MCP prompt "${serverName}/${promptName}"`,
        )
      }
      boundedResourceField(
        value,
        `MCP prompt "${serverName}/${promptName}" argument "${name}"`,
      )
    }
    for (const argument of prompt.arguments) {
      if (
        argument.required &&
        (args[argument.name] === undefined || args[argument.name]?.length === 0)
      ) {
        throw new Error(
          `Missing required argument "${argument.name}" for MCP prompt "${serverName}/${promptName}"`,
        )
      }
    }

    let response: Awaited<ReturnType<McpProtocolClient["getPrompt"]>>
    try {
      response = await withAbortableTimeout(
        (requestSignal) =>
          client.getPrompt(
            {
              name: promptName,
              ...(Object.keys(args).length > 0
                ? { arguments: { ...args } }
                : {}),
            },
            { signal: requestSignal },
          ),
        config.toolTimeoutMs ?? this.options.toolTimeoutMs,
        `MCP server "${serverName}" prompts/get`,
        [
          signal,
          this.serverLifecycles.get(serverName)?.signal,
        ].filter((item): item is AbortSignal => Boolean(item)),
        (reason) => this.handleTransportLoss(serverName, client, reason),
      )
    } catch (error) {
      if (isAuthenticationError(error)) {
        this.setStatus(config, "needs_auth", {
          error: errorMessage(error),
          toolCount: [...this.tools.values()].filter(
            (tool) => tool.serverName === serverName,
          ).length,
          connectedAt: this.statuses.get(serverName)?.connectedAt,
        })
      }
      throw error
    }
    if (response.messages.length > MAX_PROMPT_MESSAGES) {
      const error = new McpPayloadLimitError(
        `MCP prompt exceeded ${MAX_PROMPT_MESSAGES} messages`,
      )
      this.handleTransportLoss(serverName, client, error)
      throw error
    }

    let textCharacters = 0
    let totalBinaryBytes = 0
    try {
      const messages = response.messages.map((message) => {
        const raw =
          message.content &&
          typeof message.content === "object" &&
          !Array.isArray(message.content)
            ? message.content as Record<string, unknown>
            : {}
        const originalType =
          typeof raw.type === "string" ? raw.type : "unknown"
        let content: McpPromptContent
        if (originalType === "text" && typeof raw.text === "string") {
          textCharacters += raw.text.length
          content = { type: "text", text: raw.text }
        } else if (
          (originalType === "image" || originalType === "audio") &&
          typeof raw.data === "string" &&
          typeof raw.mimeType === "string"
        ) {
          const bytes = approximateBase64Bytes(raw.data)
          if (bytes > MAX_PROMPT_BINARY_BYTES) {
            throw new McpPayloadLimitError(
              `MCP prompt ${originalType} exceeded ${MAX_PROMPT_BINARY_BYTES} decoded bytes`,
            )
          }
          totalBinaryBytes += bytes
          content = {
            type: originalType,
            data: raw.data,
            mimeType: boundedResourceField(
              raw.mimeType,
              `MCP prompt ${originalType} MIME type`,
            ),
          }
        } else if (
          originalType === "resource" &&
          raw.resource &&
          typeof raw.resource === "object" &&
          !Array.isArray(raw.resource)
        ) {
          const resource = raw.resource as Record<string, unknown>
          if (
            typeof resource.uri !== "string" ||
            resource.uri.trim().length === 0
          ) {
            throw new McpPayloadLimitError(
              "MCP prompt resource is missing a non-empty URI",
            )
          }
          const uri = boundedResourceField(
            resource.uri,
            "MCP prompt resource URI",
          )
          const text =
            typeof resource.text === "string" ? resource.text : undefined
          if (text) textCharacters += text.length
          const blob =
            typeof resource.blob === "string" ? resource.blob : undefined
          if (blob) {
            const bytes = approximateBase64Bytes(blob)
            if (bytes > MAX_PROMPT_BINARY_BYTES) {
              throw new McpPayloadLimitError(
                `MCP prompt resource exceeded ${MAX_PROMPT_BINARY_BYTES} decoded bytes`,
              )
            }
            totalBinaryBytes += bytes
          }
          content = {
            type: "resource",
            uri,
            ...(typeof resource.mimeType === "string"
              ? {
                  mimeType: boundedResourceField(
                    resource.mimeType,
                    "MCP prompt resource MIME type",
                  ),
                }
              : {}),
            ...(text !== undefined ? { text } : {}),
            ...(blob !== undefined ? { blob } : {}),
          }
        } else if (
          originalType === "resource_link" &&
          typeof raw.uri === "string"
        ) {
          content = {
            type: "resource_link",
            uri: boundedResourceField(raw.uri, "MCP prompt resource link URI"),
            ...(typeof raw.name === "string"
              ? {
                  name: boundedResourceField(
                    raw.name,
                    "MCP prompt resource link name",
                  ),
                }
              : {}),
            ...(typeof raw.description === "string"
              ? { description: boundedDescription(raw.description) }
              : {}),
            ...(typeof raw.mimeType === "string"
              ? {
                  mimeType: boundedResourceField(
                    raw.mimeType,
                    "MCP prompt resource link MIME type",
                  ),
                }
              : {}),
          }
        } else {
          content = {
            type: "unsupported",
            originalType: originalType.slice(0, 128),
          }
        }
        if (textCharacters > MAX_PROMPT_TEXT_CHARS) {
          throw new McpPayloadLimitError(
            `MCP prompt exceeded ${MAX_PROMPT_TEXT_CHARS} text characters`,
          )
        }
        if (totalBinaryBytes > MAX_PROMPT_TOTAL_BINARY_BYTES) {
          throw new McpPayloadLimitError(
            `MCP prompt exceeded ${MAX_PROMPT_TOTAL_BINARY_BYTES} total decoded binary bytes`,
          )
        }
        return Object.freeze({
          role: message.role,
          content: Object.freeze(content),
        })
      })
      return Object.freeze({
        serverName,
        name: promptName,
        ...(response.description
          ? { description: boundedDescription(response.description) }
          : {}),
        messages: Object.freeze(messages),
      })
    } catch (error) {
      if (error instanceof McpPayloadLimitError) {
        this.handleTransportLoss(serverName, client, error)
      }
      throw error
    }
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
    this.lifecycleEpoch += 1
    this.reconnects.clear()
    const names = new Set([
      ...this.clients.keys(),
      ...this.configs.keys(),
      ...this.statuses.keys(),
      // A connect records its epoch before the first await, before it has a
      // client/config/status entry. Include those names so shutdown also
      // invalidates that earliest in-flight startup window.
      ...this.serverEpochs.keys(),
    ])
    for (const name of names) this.nextServerEpoch(name)
    for (const name of names) {
      await this.closeServer(name)
      const config = this.configs.get(name)
      if (config) this.setStatus(config, "disconnected")
    }
    this.clients.clear()
    this.serverLifecycles.clear()
    this.tools.clear()
    this.prompts.clear()
    this.configs.clear()
    this.refreshes.clear()
    this.promptRefreshes.clear()
    this.ensureConnects.clear()
    this.configFingerprints.clear()
  }

  close(): Promise<void> {
    return this.disconnectAll()
  }

  async listResources(
    serverName?: string,
    signal?: AbortSignal,
  ): Promise<McpResourceRef[]> {
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
        let serverResourceCount = 0
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const response = await withAbortableTimeout(
            (requestSignal) => client.listResources(
              cursor ? { cursor } : undefined,
              { signal: requestSignal },
            ),
            config.toolTimeoutMs ?? this.options.toolTimeoutMs,
            `MCP server "${name}" resources/list`,
            [
              signal,
              this.serverLifecycles.get(name)?.signal,
            ].filter((item): item is AbortSignal => Boolean(item)),
            (reason) => this.handleTransportLoss(name, client, reason),
          )
          const resources = response.resources ?? []
          serverResourceCount += resources.length
          if (serverResourceCount > MAX_RESOURCES_PER_SERVER) {
            throw new McpPayloadLimitError(
              `MCP resources/list exceeded ${MAX_RESOURCES_PER_SERVER} resources for "${name}"`,
            )
          }
          for (const resource of resources) {
            all.push({
              serverName: name,
              uri: boundedResourceField(resource.uri, "MCP resource URI"),
              name: boundedResourceField(resource.name, "MCP resource name"),
              ...(resource.description
                ? {
                    description: boundedResourceField(
                      resource.description,
                      "MCP resource description",
                    ),
                  }
                : {}),
              ...(resource.mimeType
                ? {
                    mimeType: boundedResourceField(
                      resource.mimeType,
                      "MCP resource MIME type",
                    ),
                  }
                : {}),
            })
          }
          if (!response.nextCursor) break
          if (seen.has(response.nextCursor)) {
            throw new Error(`MCP resources/list repeated cursor "${response.nextCursor}"`)
          }
          seen.add(response.nextCursor)
          cursor = response.nextCursor
          if (page === MAX_LIST_PAGES - 1) {
            throw new McpPayloadLimitError(
              `MCP resources/list exceeded ${MAX_LIST_PAGES} pages`,
            )
          }
        }
      } catch (error) {
        if (error instanceof McpPayloadLimitError) {
          this.handleTransportLoss(name, client, error)
        }
        throw error
      }
    }
    return all
  }

  async listResourceTemplates(
    serverName?: string,
    signal?: AbortSignal,
  ): Promise<McpResourceTemplateRef[]> {
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
        let serverTemplateCount = 0
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
          const response = await withAbortableTimeout(
            (requestSignal) => client.listResourceTemplates(
              cursor ? { cursor } : undefined,
              { signal: requestSignal },
            ),
            config.toolTimeoutMs ?? this.options.toolTimeoutMs,
            `MCP server "${name}" resources/templates/list`,
            [
              signal,
              this.serverLifecycles.get(name)?.signal,
            ].filter((item): item is AbortSignal => Boolean(item)),
            (reason) => this.handleTransportLoss(name, client, reason),
          )
          const templates = response.resourceTemplates ?? []
          serverTemplateCount += templates.length
          if (serverTemplateCount > MAX_RESOURCES_PER_SERVER) {
            throw new McpPayloadLimitError(
              `MCP resources/templates/list exceeded ${MAX_RESOURCES_PER_SERVER} templates for "${name}"`,
            )
          }
          for (const template of templates) {
            all.push({
              serverName: name,
              uriTemplate: boundedResourceField(
                template.uriTemplate,
                "MCP resource template URI",
              ),
              name: boundedResourceField(
                template.name,
                "MCP resource template name",
              ),
              ...(template.description
                ? {
                    description: boundedResourceField(
                      template.description,
                      "MCP resource template description",
                    ),
                  }
                : {}),
              ...(template.mimeType
                ? {
                    mimeType: boundedResourceField(
                      template.mimeType,
                      "MCP resource template MIME type",
                    ),
                  }
                : {}),
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
          if (page === MAX_LIST_PAGES - 1) {
            throw new McpPayloadLimitError(
              `MCP resources/templates/list exceeded ${MAX_LIST_PAGES} pages`,
            )
          }
        }
      } catch (error) {
        if (error instanceof McpPayloadLimitError) {
          this.handleTransportLoss(name, client, error)
        }
        throw error
      }
    }
    return all
  }

  async readResource(
    serverName: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<McpResourceContent[]> {
    const client = this.clients.get(serverName)
    const config = this.configs.get(serverName)
    if (!client || !config) {
      throw new Error(`MCP server "${serverName}" not connected`)
    }
    const response = await withAbortableTimeout(
      (requestSignal) => client.readResource({ uri }, { signal: requestSignal }),
      config.toolTimeoutMs ?? this.options.toolTimeoutMs,
      `MCP server "${serverName}" resources/read`,
      [
        signal,
        this.serverLifecycles.get(serverName)?.signal,
      ].filter((item): item is AbortSignal => Boolean(item)),
      (reason) => this.handleTransportLoss(serverName, client, reason),
    )
    const contents = response.contents ?? []
    if (contents.length > MAX_RESOURCE_CONTENT_ITEMS) {
      const error = new McpPayloadLimitError(
        `MCP resource read exceeded ${MAX_RESOURCE_CONTENT_ITEMS} content items`,
      )
      this.handleTransportLoss(serverName, client, error)
      throw error
    }
    let textChars = 0
    let blobBytes = 0
    try {
      return contents.map((item) => {
        if (typeof item.text === "string") {
          textChars += item.text.length
          if (textChars > MAX_RESOURCE_TEXT_CHARS) {
            throw new McpPayloadLimitError(
              `MCP resource text exceeded ${MAX_RESOURCE_TEXT_CHARS} characters`,
            )
          }
        }
        if (typeof item.blob === "string") {
          const bytes = approximateBase64Bytes(item.blob)
          if (bytes > MAX_RESOURCE_BLOB_BYTES) {
            throw new McpPayloadLimitError(
              `MCP resource blob exceeded ${MAX_RESOURCE_BLOB_BYTES} decoded bytes`,
            )
          }
          blobBytes += bytes
          if (blobBytes > MAX_RESOURCE_TOTAL_BLOB_BYTES) {
            throw new McpPayloadLimitError(
              `MCP resource blobs exceeded ${MAX_RESOURCE_TOTAL_BLOB_BYTES} total decoded bytes`,
            )
          }
        }
        return {
          serverName,
          uri: boundedResourceField(item.uri, "MCP resource URI"),
          ...(item.mimeType
            ? {
                mimeType: boundedResourceField(
                  item.mimeType,
                  "MCP resource MIME type",
                ),
              }
            : {}),
          ...(typeof item.text === "string" ? { text: item.text } : {}),
          ...(typeof item.blob === "string" ? { blob: item.blob } : {}),
        }
      })
    } catch (error) {
      if (error instanceof McpPayloadLimitError) {
        this.handleTransportLoss(serverName, client, error)
      }
      throw error
    }
  }

  async authenticate(
    serverName: string,
    host?: IHost,
  ): Promise<{ success: boolean; pending?: boolean; message: string }> {
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
    if (auth.type === "oauth") {
      return {
        success: false,
        message:
          `MCP OAuth for "${serverName}" is not available in this NexusCode build. ` +
          "A browser URL alone cannot complete OAuth safely; configure a manual/url handoff or use static credentials until the workspace OAuth coordinator is enabled.",
      }
    }
    let startUrl: string | undefined
    if (auth.startUrl) {
      try {
        startUrl = parseMcpHttpUrl(
          auth.startUrl,
          `MCP server "${serverName}" authentication URL`,
        ).href
      } catch (error) {
        return {
          success: false,
          message: errorMessage(error),
        }
      }
    }
    if (host?.requestMcpAuthentication) {
      const result = await host.requestMcpAuthentication({
        server: serverName,
        ...(auth.message ? { message: auth.message } : {}),
        ...(startUrl ? { startUrl } : {}),
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
    if (startUrl) {
      return {
        success: false,
        pending: true,
        message: `${auth.message?.trim() || `Open the following URL to authenticate ${serverName}:`}\n${startUrl}`,
      }
    }
    return {
      success: false,
      message: auth.message?.trim() ||
        `MCP server "${serverName}" requires manual authentication.`,
    }
  }
}

export function renderMcpPromptResult(result: McpPromptResult): string {
  return result.messages
    .map((message) => {
      const content = message.content
      let body: string
      switch (content.type) {
        case "text":
          body = content.text
          break
        case "image":
        case "audio":
          body = `[MCP ${content.type}: ${content.mimeType}]`
          break
        case "resource":
          body =
            content.text ??
            `[MCP resource: ${content.uri}${
              content.mimeType ? ` (${content.mimeType})` : ""
            }]`
          break
        case "resource_link":
          body = `[MCP resource link: ${content.name ?? content.uri} — ${content.uri}]`
          break
        case "unsupported":
          body = `[Unsupported MCP prompt content: ${content.originalType}]`
          break
      }
      return message.role === "assistant"
        ? `Assistant:\n${body}`
        : body
    })
    .join("\n\n")
}

/** Standalone test of MCP server configs (does not keep connections). */
export async function testMcpServers(
  configs: McpServerConfig[],
): Promise<Array<{ name: string; status: "ok" | "error"; error?: string }>> {
  return new McpClient().testServers(configs)
}

export { buildMcpToolSchema } from "./payload-limits.js"
export type {
  McpClientOptions,
  McpConnectionState,
  McpPromptArgument,
  McpPromptContent,
  McpPromptMessage,
  McpPromptRef,
  McpPromptResult,
  McpResourceContent,
  McpResourceRef,
  McpResourceTemplateRef,
  McpServerStatus,
  McpTool,
} from "./types.js"
