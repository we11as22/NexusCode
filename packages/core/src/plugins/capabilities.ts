import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { McpServerConfig, NexusConfig, PluginManifestRecord } from "../types.js"
import { McpServerConfigSchema } from "../config/schema.js"
import { getPendingProjectMcpServers } from "../config/index.js"
import { resolvePluginDeclaredPath } from "./index.js"
import { loadTrustedPluginRuntimeRecords } from "./runtime.js"

export interface PluginCapabilityDiagnostic {
  level: "warning" | "error"
  code:
    | "plugin-mcp-file-invalid"
    | "plugin-mcp-server-invalid"
    | "plugin-mcp-server-shadowed"
    | "plugin-mcp-cwd-escape"
    | "project-mcp-pending"
    | "project-mcp-pending-invalid"
  pluginName: string
  path: string
  serverName?: string
  message: string
}

export interface McpServerCapabilityProvenance {
  serverName: string
  status: "active" | "pending" | "shadowed"
  source:
    | "plugin-inline"
    | "plugin-file"
    | "trusted-runtime-config"
    | "project-config"
    | "project-mcp-json"
  path: string
  pluginName?: string
  pluginRoot?: string
  trustBinding?: "exact-content-grant"
  message?: string
}

export interface PendingMcpServerCapability {
  server: McpServerConfig
  provenance: McpServerCapabilityProvenance
}

export interface PluginMcpCapabilityResult {
  servers: McpServerConfig[]
  diagnostics: PluginCapabilityDiagnostic[]
  provenance: McpServerCapabilityProvenance[]
  pendingServers: PendingMcpServerCapability[]
}

type ParsedPluginMcpResult = Pick<PluginMcpCapabilityResult, "servers" | "diagnostics">

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function substitutePluginRoot(value: string, pluginRoot: string): string {
  return value.replace(
    /\$\{(?:CLAUDE|CODEX|NEXUS)_PLUGIN_ROOT\}/g,
    pluginRoot,
  )
}

function serverCandidates(value: unknown): Array<{ name?: string; value: unknown }> | null {
  if (Array.isArray(value)) return value.map((item) => ({ value: item }))
  const root = asObject(value)
  if (!root) return null
  const nested =
    root.servers ??
    root.mcpServers ??
    asObject(root.mcp)?.servers
  if (Array.isArray(nested)) return nested.map((item) => ({ value: item }))
  const map = asObject(nested) ?? (
    !("servers" in root) && !("mcpServers" in root) && !("mcp" in root)
      ? root
      : null
  )
  return map
    ? Object.entries(map).map(([name, item]) => ({ name, value: item }))
    : null
}

async function normalizePluginServer(
  plugin: PluginManifestRecord,
  name: string | undefined,
  raw: unknown,
): Promise<
  | { server: McpServerConfig }
  | { code: "plugin-mcp-server-invalid" | "plugin-mcp-cwd-escape"; message: string }
> {
  const value = asObject(raw)
  if (!value) {
    return { code: "plugin-mcp-server-invalid", message: "Server configuration must be an object." }
  }
  const candidate = { ...value, ...(name && !value.name ? { name } : {}) }
  const parsed = McpServerConfigSchema.safeParse(candidate)
  if (!parsed.success) {
    return {
      code: "plugin-mcp-server-invalid",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; "),
    }
  }
  const root = await fs.realpath(plugin.rootDir)
  const substitutedCwd = parsed.data.cwd
    ? substitutePluginRoot(parsed.data.cwd, root)
    : undefined
  const configuredCwd = substitutedCwd
    ? path.resolve(plugin.rootDir, substitutedCwd)
    : root
  const canonicalCwd = await fs.realpath(configuredCwd).catch(() => configuredCwd)
  if (!isPathInside(root, canonicalCwd)) {
    return {
      code: "plugin-mcp-cwd-escape",
      message: `MCP cwd escapes plugin root: ${parsed.data.cwd}`,
    }
  }
  return {
    server: {
      ...parsed.data,
      ...(parsed.data.command
        ? { command: substitutePluginRoot(parsed.data.command, root) }
        : {}),
      ...(parsed.data.args
        ? { args: parsed.data.args.map((arg) => substitutePluginRoot(arg, root)) }
        : {}),
      ...(parsed.data.env
        ? {
            env: Object.fromEntries(
              Object.entries(parsed.data.env).map(([key, envValue]) => [
                key,
                substitutePluginRoot(envValue, root),
              ]),
            ),
          }
        : {}),
      ...(parsed.data.url
        ? { url: substitutePluginRoot(parsed.data.url, root) }
        : {}),
      ...(parsed.data.command ? { cwd: canonicalCwd } : {}),
    },
  }
}

async function parsePluginMcpFile(
  plugin: PluginManifestRecord,
  filePath: string,
): Promise<ParsedPluginMcpResult> {
  const diagnostics: PluginCapabilityDiagnostic[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch (error) {
    return {
      servers: [],
      diagnostics: [{
        level: "error",
        code: "plugin-mcp-file-invalid",
        pluginName: plugin.name,
        path: filePath,
        message: error instanceof Error ? error.message : String(error),
      }],
    }
  }
  const candidates = serverCandidates(parsed)
  if (!candidates) {
    return {
      servers: [],
      diagnostics: [{
        level: "error",
        code: "plugin-mcp-file-invalid",
        pluginName: plugin.name,
        path: filePath,
        message: "Expected an array, a server map, or an object containing servers/mcpServers.",
      }],
    }
  }
  const servers: McpServerConfig[] = []
  for (const candidate of candidates) {
    const normalized = await normalizePluginServer(plugin, candidate.name, candidate.value)
    if ("server" in normalized) {
      servers.push(normalized.server)
      continue
    }
    diagnostics.push({
      level: "error",
      code: normalized.code,
      pluginName: plugin.name,
      path: filePath,
      ...(candidate.name ? { serverName: candidate.name } : {}),
      message: normalized.message,
    })
  }
  return { servers, diagnostics }
}

async function parseInlinePluginMcpServers(
  plugin: PluginManifestRecord,
): Promise<ParsedPluginMcpResult> {
  if (!plugin.inlineMcpServers) return { servers: [], diagnostics: [] }
  const servers: McpServerConfig[] = []
  const diagnostics: PluginCapabilityDiagnostic[] = []
  for (const [name, value] of Object.entries(plugin.inlineMcpServers)) {
    const normalized = await normalizePluginServer(plugin, name, value)
    if ("server" in normalized) {
      servers.push(normalized.server)
    } else {
      diagnostics.push({
        level: "error",
        code: normalized.code,
        pluginName: plugin.name,
        path: plugin.sourcePath,
        serverName: name,
        message: normalized.message,
      })
    }
  }
  return { servers, diagnostics }
}

/**
 * Load MCP server definitions contributed by explicitly trusted and enabled
 * plugins. Invalid siblings are isolated and reported instead of hiding valid
 * servers from the same file.
 */
export async function loadPluginMcpServers(
  cwd: string,
  config: NexusConfig,
): Promise<PluginMcpCapabilityResult> {
  const plugins = await loadTrustedPluginRuntimeRecords(cwd, config)
  const diagnostics: PluginCapabilityDiagnostic[] = []
  const shadowedProvenance: McpServerCapabilityProvenance[] = []
  const byName = new Map<string, {
    plugin: PluginManifestRecord
    server: McpServerConfig
    path: string
    source: "plugin-inline" | "plugin-file"
  }>()
  const addServer = (
    plugin: PluginManifestRecord,
    server: McpServerConfig,
    sourcePath: string,
    source: "plugin-inline" | "plugin-file",
  ): void => {
    const existing = byName.get(server.name)
    if (existing) {
      const message = `Server is shadowed by plugin ${existing.plugin.name} (${existing.path}).`
      diagnostics.push({
        level: "warning",
        code: "plugin-mcp-server-shadowed",
        pluginName: plugin.name,
        path: sourcePath,
        serverName: server.name,
        message,
      })
      shadowedProvenance.push({
        serverName: server.name,
        status: "shadowed",
        source,
        path: sourcePath,
        pluginName: plugin.name,
        pluginRoot: plugin.rootDir,
        trustBinding: "exact-content-grant",
        message,
      })
      return
    }
    byName.set(server.name, {
      plugin,
      server,
      path: sourcePath,
      source,
    })
  }
  for (const plugin of plugins) {
    const inline = await parseInlinePluginMcpServers(plugin)
    diagnostics.push(...inline.diagnostics)
    for (const server of inline.servers) {
      addServer(plugin, server, plugin.sourcePath, "plugin-inline")
    }
    for (const declared of plugin.mcpServers) {
      const filePath = resolvePluginDeclaredPath(plugin, declared)
      const result = await parsePluginMcpFile(plugin, filePath)
      diagnostics.push(...result.diagnostics)
      for (const server of result.servers) {
        addServer(plugin, server, filePath, "plugin-file")
      }
    }
  }
  return {
    servers: Array.from(byName.values(), (item) => item.server),
    diagnostics,
    provenance: [
      ...Array.from(byName.values(), (item): McpServerCapabilityProvenance => ({
        serverName: item.server.name,
        status: "active",
        source: item.source,
        path: item.path,
        pluginName: item.plugin.name,
        pluginRoot: item.plugin.rootDir,
        trustBinding: "exact-content-grant",
      })),
      ...shadowedProvenance,
    ],
    pendingServers: [],
  }
}

/** Explicit project/user MCP configuration wins over plugin contributions. */
export async function resolveConfiguredAndPluginMcpServers(
  cwd: string,
  config: NexusConfig,
): Promise<PluginMcpCapabilityResult> {
  const plugin = await loadPluginMcpServers(cwd, config)
  const explicitNames = new Set(config.mcp.servers.map((server) => server.name))
  const pendingServers: PendingMcpServerCapability[] = []
  const pendingDiagnostics: PluginCapabilityDiagnostic[] = []
  for (const request of getPendingProjectMcpServers(config)) {
    const parsed = McpServerConfigSchema.safeParse(request.config)
    const name = typeof request.config["name"] === "string"
      ? request.config["name"]
      : "(unnamed)"
    if (!parsed.success) {
      pendingDiagnostics.push({
        level: "error",
        code: "project-mcp-pending-invalid",
        pluginName: "project-config",
        path: request.origin === "project-config"
          ? ".nexus/nexus.yaml"
          : ".nexus/mcp-servers.json",
        serverName: name,
        message: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
          .join("; "),
      })
      continue
    }
    const provenance: McpServerCapabilityProvenance = {
      serverName: parsed.data.name,
      status: "pending",
      source: request.origin,
      path: request.origin === "project-config"
        ? ".nexus/nexus.yaml"
        : ".nexus/mcp-servers.json",
      message: "Project MCP definitions require explicit host promotion before startup.",
    }
    pendingServers.push({ server: parsed.data, provenance })
    pendingDiagnostics.push({
      level: "warning",
      code: "project-mcp-pending",
      pluginName: "project-config",
      path: provenance.path,
      serverName: parsed.data.name,
      message: provenance.message!,
    })
  }
  const pluginProvenance = plugin.provenance.map((item) =>
    item.status === "active" && explicitNames.has(item.serverName)
      ? {
          ...item,
          status: "shadowed" as const,
          message: `Trusted runtime MCP server ${item.serverName} overrides the plugin contribution.`,
        }
      : item
  )
  return {
    servers: [
      ...plugin.servers.filter((server) => !explicitNames.has(server.name)),
      ...config.mcp.servers,
    ],
    diagnostics: [
      ...plugin.diagnostics,
      ...plugin.servers
        .filter((server) => explicitNames.has(server.name))
        .map((server): PluginCapabilityDiagnostic => ({
          level: "warning",
          code: "plugin-mcp-server-shadowed",
          pluginName: "runtime-config",
          path: ".nexus/nexus.yaml",
          serverName: server.name,
          message: `Explicit MCP server ${server.name} overrides the plugin contribution.`,
        })),
      ...pendingDiagnostics,
    ],
    provenance: [
      ...pluginProvenance,
      ...config.mcp.servers.map((server): McpServerCapabilityProvenance => ({
        serverName: server.name,
        status: "active",
        source: "trusted-runtime-config",
        path: "host-owned configuration",
      })),
      ...pendingServers.map((item) => item.provenance),
    ],
    pendingServers,
  }
}
