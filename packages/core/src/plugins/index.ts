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
  description: z.string().min(1),
  commands: z.array(z.string()).optional(),
  agents: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  hooks: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  settingsSchema: z.record(z.unknown()).optional(),
})

const MANIFEST_PATTERNS = [
  ".nexus/plugins/**/plugin.json",
  ".nexus/plugins/**/.nexus-plugin/plugin.json",
  ".nexus/plugins/**/.codex-plugin/plugin.json",
]

function getPluginRootDir(manifestPath: string): string {
  const dir = path.dirname(manifestPath)
  const base = path.basename(dir)
  if (base === ".nexus-plugin" || base === ".codex-plugin") {
    return path.dirname(dir)
  }
  return dir
}

function hasParentTraversal(value: string): boolean {
  return value.split(/[\\/]+/).includes("..")
}

function normalizeDeclaredList(value: unknown, field: string, warnings: string[]): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
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

export function resolvePluginDeclaredPath(plugin: PluginManifestRecord, declaredPath: string): string {
  return path.resolve(plugin.rootDir, declaredPath)
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
  const plugin: PluginManifestRecord = {
    name: result.data.name.trim(),
    version: result.data.version?.trim() || undefined,
    description: result.data.description.trim(),
    commands: normalizeDeclaredList(result.data.commands, "commands", warnings),
    agents: normalizeDeclaredList(result.data.agents, "agents", warnings),
    skills: normalizeDeclaredList(result.data.skills, "skills", warnings),
    hooks: normalizeDeclaredList(result.data.hooks, "hooks", warnings),
    mcpServers: normalizeDeclaredList(result.data.mcpServers, "mcpServers", warnings),
    enabled: result.data.enabled ?? true,
    settingsSchema: result.data.settingsSchema as Record<string, unknown> | undefined,
    rootDir: getPluginRootDir(absPath),
    sourcePath: absPath,
    scope: absPath.startsWith(path.join(os.homedir(), ".nexus")) ? "global" : "project",
    warnings,
  }

  return { success: true, errors: [], warnings, plugin }
}

export async function loadPluginManifests(cwd: string, compatibility?: ClaudeCompatibilityOptions): Promise<PluginManifestRecord[]> {
  const baseDirs = [path.resolve(cwd), os.homedir()]
  const patterns = [
    path.join(baseDirs[1], ".nexus", "plugins", "**", "plugin.json"),
    path.join(baseDirs[1], ".nexus", "plugins", "**", ".nexus-plugin", "plugin.json"),
    path.join(baseDirs[1], ".nexus", "plugins", "**", ".codex-plugin", "plugin.json"),
    path.join(baseDirs[0], ".nexus", "plugins", "**", "plugin.json"),
    path.join(baseDirs[0], ".nexus", "plugins", "**", ".nexus-plugin", "plugin.json"),
    path.join(baseDirs[0], ".nexus", "plugins", "**", ".codex-plugin", "plugin.json"),
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

  const files = (
    await Promise.all(patterns.map((pattern) => glob(pattern, { absolute: true }).catch(() => [] as string[])))
  )
    .flat()
    .sort()

  const byName = new Map<string, PluginManifestRecord>()
  for (const file of files) {
    const validated = await validatePluginManifestFile(file)
    if (!validated.success || !validated.plugin || !validated.plugin.enabled) continue
    const existing = byName.get(validated.plugin.name)
    if (!existing || (existing.scope === "global" && validated.plugin.scope === "project")) {
      byName.set(validated.plugin.name, validated.plugin)
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
}

export { MANIFEST_PATTERNS }
