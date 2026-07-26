import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { glob } from "glob"
import { z } from "zod"
import type { PluginManifestRecord } from "../types.js"
import type { ClaudeCompatibilityOptions } from "../compat/claude.js"

const pluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().min(1).optional(),
  commands: z.unknown().optional(),
  agents: z.unknown().optional(),
  skills: z.unknown().optional(),
  hooks: z.unknown().optional(),
  mcpServers: z.unknown().optional(),
  enabled: z.boolean().optional(),
  settingsSchema: z.record(z.unknown()).optional(),
})

const MANIFEST_PATTERNS = [
  ".nexus/plugins/**/plugin.json",
  ".nexus/plugins/**/.nexus-plugin/plugin.json",
  ".nexus/plugins/**/.codex-plugin/plugin.json",
  ".nexus/plugins/**/.claude-plugin/plugin.json",
]

export interface PluginDiagnostic {
  level: "warning" | "error"
  code:
    | "manifest-glob-failed"
    | "manifest-invalid"
    | "manifest-shadowed"
  path: string
  pluginName?: string
  message: string
}

export interface PluginDiscoveryResult {
  plugins: PluginManifestRecord[]
  diagnostics: PluginDiagnostic[]
}

function getPluginRootDir(manifestPath: string): string {
  const dir = path.dirname(manifestPath)
  const base = path.basename(dir)
  if (base === ".nexus-plugin" || base === ".codex-plugin" || base === ".claude-plugin") {
    return path.dirname(dir)
  }
  return dir
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/).includes("..")
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function normalizeDeclaredList(value: unknown, field: string, warnings: string[]): string[] {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : []
  const out: string[] = []
  for (const item of values) {
    if (typeof item !== "string") continue
    const trimmed = item.trim()
    if (!trimmed) continue
    if (hasParentTraversal(trimmed)) {
      warnings.push(`${field}: ignored path with '..' traversal: ${trimmed}`)
      continue
    }
    out.push(trimmed)
  }
  return out
}

function normalizeCommandEntries(
  value: unknown,
  warnings: string[],
): NonNullable<PluginManifestRecord["commandEntries"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  const entries: NonNullable<PluginManifestRecord["commandEntries"]> = []
  for (const [name, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      warnings.push(`commands.${name}: expected an object`)
      continue
    }
    const item = raw as Record<string, unknown>
    const source = typeof item.source === "string" ? item.source.trim() : undefined
    const content = typeof item.content === "string" ? item.content.trim() : undefined
    if ((!source && !content) || (source && content)) {
      warnings.push(`commands.${name}: expected exactly one of source or content`)
      continue
    }
    entries.push({
      name,
      ...(source ? { source } : {}),
      ...(content ? { content } : {}),
      ...(typeof item.description === "string" ? { description: item.description } : {}),
    })
  }
  return entries
}

function normalizeInlineMcpServers(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

async function addDefaultPath(
  pluginRootDir: string,
  values: string[],
  defaultPath: string,
): Promise<string[]> {
  if (values.length > 0) return values
  const stats = await fs.stat(path.join(pluginRootDir, defaultPath)).catch(() => null)
  return stats ? [defaultPath] : values
}

async function validateDeclaredPaths(
  pluginRootDir: string,
  values: string[],
  field: string,
  errors: string[],
): Promise<void> {
  const canonicalRoot = await fs.realpath(pluginRootDir).catch(() => path.resolve(pluginRootDir))
  for (const declaredPath of values) {
    const absPath = path.resolve(pluginRootDir, declaredPath)
    if (!isPathInside(path.resolve(pluginRootDir), absPath)) {
      errors.push(`${field}: path escapes plugin root: ${declaredPath}`)
      continue
    }
    try {
      const canonicalTarget = await fs.realpath(absPath)
      if (!isPathInside(canonicalRoot, canonicalTarget)) {
        errors.push(`${field}: symlink target escapes plugin root: ${declaredPath}`)
      }
    } catch {
      errors.push(`${field}: declared path does not exist: ${declaredPath}`)
    }
  }
}

export function resolvePluginDeclaredPath(plugin: PluginManifestRecord, declaredPath: string): string {
  const resolved = path.resolve(plugin.rootDir, declaredPath)
  if (!isPathInside(path.resolve(plugin.rootDir), resolved)) {
    throw new Error(`Plugin path escapes root: ${plugin.name}:${declaredPath}`)
  }
  return resolved
}

export async function validatePluginManifestFile(filePath: string): Promise<{ success: boolean; errors: string[]; warnings: string[]; plugin?: PluginManifestRecord }> {
  const absPath = path.resolve(filePath)
  let raw: string
  try {
    raw = await fs.readFile(absPath, "utf8")
  } catch (error) {
    return {
      success: false,
      errors: [`Could not read plugin manifest ${absPath}: ${(error as Error).message}`],
      warnings: [],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      success: false,
      errors: [`Invalid JSON in ${absPath}: ${(error as Error).message}`],
      warnings: [],
    }
  }

  const result = pluginManifestSchema.safeParse(parsed)
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`),
      warnings: [],
    }
  }

  const warnings: string[] = []
  const errors: string[] = []
  const rootDir = getPluginRootDir(absPath)
  const commandEntries = normalizeCommandEntries(result.data.commands, warnings)
  const commandSources = commandEntries
    .map((entry) => entry.source)
    .filter((entry): entry is string => Boolean(entry))
  const inlineMcpServers = normalizeInlineMcpServers(result.data.mcpServers)
  const plugin: PluginManifestRecord = {
    name: result.data.name.trim(),
    version: result.data.version?.trim() || undefined,
    description: result.data.description?.trim() || result.data.name.trim(),
    commands: [
      ...normalizeDeclaredList(result.data.commands, "commands", warnings),
      ...commandSources,
    ],
    ...(commandEntries.length ? { commandEntries } : {}),
    agents: normalizeDeclaredList(result.data.agents, "agents", warnings),
    skills: normalizeDeclaredList(result.data.skills, "skills", warnings),
    hooks: normalizeDeclaredList(result.data.hooks, "hooks", warnings),
    mcpServers: normalizeDeclaredList(result.data.mcpServers, "mcpServers", warnings),
    ...(inlineMcpServers ? { inlineMcpServers } : {}),
    enabled: result.data.enabled ?? true,
    settingsSchema: result.data.settingsSchema as Record<string, unknown> | undefined,
    rootDir,
    sourcePath: absPath,
    scope:
      isPathInside(path.join(os.homedir(), ".nexus"), absPath) ||
      isPathInside(path.join(os.homedir(), ".claude"), absPath)
        ? "global"
        : "project",
    warnings,
  }

  plugin.commands = await addDefaultPath(rootDir, plugin.commands, "commands")
  plugin.agents = await addDefaultPath(rootDir, plugin.agents, "agents")
  plugin.skills = await addDefaultPath(rootDir, plugin.skills, "skills")
  const defaultMcp = await fs.stat(path.join(rootDir, ".mcp.json")).catch(() => null)
  if (defaultMcp?.isFile() && !plugin.mcpServers.includes(".mcp.json")) {
    plugin.mcpServers.unshift(".mcp.json")
  }

  await Promise.all([
    validateDeclaredPaths(rootDir, plugin.commands, "commands", errors),
    validateDeclaredPaths(rootDir, plugin.agents, "agents", errors),
    validateDeclaredPaths(rootDir, plugin.skills, "skills", errors),
    validateDeclaredPaths(rootDir, plugin.mcpServers, "mcpServers", errors),
  ])

  for (const hook of plugin.hooks) {
    const idx = hook.indexOf(":")
    if (idx === -1) {
      warnings.push(`hooks: expected event:path format, assuming after_tool:${hook}`)
      continue
    }
    const event = hook.slice(0, idx).trim()
    const declaredPath = hook.slice(idx + 1).trim()
    if (!event) {
      errors.push(`hooks: missing hook event for ${hook}`)
      continue
    }
    if (!declaredPath) {
      errors.push(`hooks: missing hook path for ${hook}`)
      continue
    }
    await validateDeclaredPaths(rootDir, [declaredPath], "hooks", errors)
  }

  return { success: errors.length === 0, errors, warnings, ...(errors.length === 0 ? { plugin } : {}) }
}

export async function discoverPluginManifests(
  cwd: string,
  compatibility?: ClaudeCompatibilityOptions,
): Promise<PluginDiscoveryResult> {
  const baseDirs = [path.resolve(cwd), os.homedir()]
  const patterns = [
    path.join(baseDirs[1], ".nexus", "plugins", "**", "plugin.json"),
    path.join(baseDirs[1], ".nexus", "plugins", "**", ".nexus-plugin", "plugin.json"),
    path.join(baseDirs[1], ".nexus", "plugins", "**", ".codex-plugin", "plugin.json"),
    path.join(baseDirs[1], ".nexus", "plugins", "**", ".claude-plugin", "plugin.json"),
    path.join(baseDirs[0], ".nexus", "plugins", "**", "plugin.json"),
    path.join(baseDirs[0], ".nexus", "plugins", "**", ".nexus-plugin", "plugin.json"),
    path.join(baseDirs[0], ".nexus", "plugins", "**", ".codex-plugin", "plugin.json"),
    path.join(baseDirs[0], ".nexus", "plugins", "**", ".claude-plugin", "plugin.json"),
    ...(compatibility?.includeGlobalDir && compatibility?.includePlugins
      ? [
          path.join(baseDirs[1], ".claude", "plugins", "**", "plugin.json"),
          path.join(baseDirs[1], ".claude", "plugins", "**", ".claude-plugin", "plugin.json"),
        ]
      : []),
    ...(compatibility?.includeProjectDir && compatibility?.includePlugins
      ? [
          path.join(baseDirs[0], ".claude", "plugins", "**", "plugin.json"),
          path.join(baseDirs[0], ".claude", "plugins", "**", ".claude-plugin", "plugin.json"),
        ]
      : []),
  ]

  const diagnostics: PluginDiagnostic[] = []
  const discovered = await Promise.all(patterns.map(async (pattern) => {
    try {
      return await glob(pattern, { absolute: true })
    } catch (error) {
      diagnostics.push({
        level: "error",
        code: "manifest-glob-failed",
        path: pattern,
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }))
  const files = [...new Set(discovered.flat().map((file) => path.resolve(file)))].sort()

  const byName = new Map<string, PluginManifestRecord>()
  for (const file of files) {
    const validated = await validatePluginManifestFile(file)
    if (!validated.success || !validated.plugin) {
      diagnostics.push(...validated.errors.map((message) => ({
        level: "error" as const,
        code: "manifest-invalid" as const,
        path: file,
        message,
      })))
      continue
    }
    diagnostics.push(...validated.warnings.map((message) => ({
      level: "warning" as const,
      code: "manifest-invalid" as const,
      path: file,
      pluginName: validated.plugin!.name,
      message,
    })))
    if (!validated.plugin.enabled) continue
    const existing = byName.get(validated.plugin.name)
    if (!existing || (existing.scope === "global" && validated.plugin.scope === "project")) {
      if (existing) {
        diagnostics.push({
          level: "warning",
          code: "manifest-shadowed",
          path: existing.sourcePath,
          pluginName: existing.name,
          message: `Shadowed by higher-priority manifest ${validated.plugin.sourcePath}`,
        })
      }
      byName.set(validated.plugin.name, validated.plugin)
    } else {
      diagnostics.push({
        level: "warning",
        code: "manifest-shadowed",
        path: validated.plugin.sourcePath,
        pluginName: validated.plugin.name,
        message: `Shadowed by higher-priority manifest ${existing.sourcePath}`,
      })
    }
  }

  return {
    plugins: Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name)),
    diagnostics,
  }
}

export async function loadPluginManifests(
  cwd: string,
  compatibility?: ClaudeCompatibilityOptions,
): Promise<PluginManifestRecord[]> {
  return (await discoverPluginManifests(cwd, compatibility)).plugins
}

export { MANIFEST_PATTERNS }
