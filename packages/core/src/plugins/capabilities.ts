import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { McpServerConfig, NexusConfig, PluginManifestRecord } from "../types.js"
import { McpServerConfigSchema } from "../config/schema.js"
import { resolvePluginDeclaredPath } from "./index.js"
import { loadTrustedPluginRuntimeRecords } from "./runtime.js"

export interface PluginCapabilityDiagnostic {
  level: "warning" | "error"
  code:
    | "plugin-mcp-file-invalid"
    | "plugin-mcp-server-invalid"
    | "plugin-mcp-server-shadowed"
    | "plugin-mcp-cwd-escape"
  pluginName: string
  path: string
  serverName?: string
  message: string
}

export interface PluginMcpCapabilityResult {
  servers: McpServerConfig[]
  diagnostics: PluginCapabilityDiagnostic[]
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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
  const configuredCwd = parsed.data.cwd
    ? path.resolve(plugin.rootDir, parsed.data.cwd)
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
      ...(parsed.data.command ? { cwd: canonicalCwd } : {}),
    },
  }
}

async function parsePluginMcpFile(
  plugin: PluginManifestRecord,
  filePath: string,
): Promise<PluginMcpCapabilityResult> {
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
): Promise<PluginMcpCapabilityResult> {
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
  const byName = new Map<string, { plugin: PluginManifestRecord; server: McpServerConfig; path: string }>()
  for (const plugin of plugins) {
    const inline = await parseInlinePluginMcpServers(plugin)
    diagnostics.push(...inline.diagnostics)
    for (const server of inline.servers) {
      byName.set(server.name, { plugin, server, path: plugin.sourcePath })
    }
    for (const declared of plugin.mcpServers) {
      const filePath = resolvePluginDeclaredPath(plugin, declared)
      const result = await parsePluginMcpFile(plugin, filePath)
      diagnostics.push(...result.diagnostics)
      for (const server of result.servers) {
        const existing = byName.get(server.name)
        if (existing) {
          diagnostics.push({
            level: "warning",
            code: "plugin-mcp-server-shadowed",
            pluginName: plugin.name,
            path: filePath,
            serverName: server.name,
            message: `Server is shadowed by plugin ${existing.plugin.name} (${existing.path}).`,
          })
          continue
        }
        byName.set(server.name, { plugin, server, path: filePath })
      }
    }
  }
  return {
    servers: Array.from(byName.values(), (item) => item.server),
    diagnostics,
  }
}

/** Explicit project/user MCP configuration wins over plugin contributions. */
export async function resolveConfiguredAndPluginMcpServers(
  cwd: string,
  config: NexusConfig,
): Promise<PluginMcpCapabilityResult> {
  const plugin = await loadPluginMcpServers(cwd, config)
  const explicitNames = new Set(config.mcp.servers.map((server) => server.name))
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
    ],
  }
}
