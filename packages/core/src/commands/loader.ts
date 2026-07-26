import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { glob } from "glob"
import type { ClaudeCompatibilityOptions } from "../compat/claude.js"
import type { NexusConfig } from "../types.js"
import { resolvePluginDeclaredPath } from "../plugins/index.js"
import { loadTrustedPluginRuntimeRecords } from "../plugins/runtime.js"

export interface LoadedSlashCommand {
  command: string
  scope: "project" | "user" | "plugin"
  sourcePath: string
  description: string
  prompt: string
  pluginName?: string
}

export type SlashCommandResolution =
  | { status: "resolved"; command: LoadedSlashCommand }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "not-found" }

function buildCommandName(scope: "project" | "user", sourcePath: string, baseDir: string): string {
  const rel = path.relative(baseDir, sourcePath).replace(/\\/g, "/").replace(/\.md$/i, "")
  return `${scope}:${rel}`
}

function summarizePrompt(text: string): string {
  const cleaned = text.replace(/^---[\s\S]*?---\s*/m, "").trim()
  const first = cleaned.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ""
  return first.replace(/^#+\s*/, "").slice(0, 160) || "Custom slash command"
}

async function readCommandFile(
  sourcePath: string,
  scope: "project" | "user",
  baseDir: string,
): Promise<LoadedSlashCommand | null> {
  try {
    const raw = await fs.readFile(sourcePath, "utf8")
    const prompt = raw.trim()
    if (!prompt) return null
    return {
      command: buildCommandName(scope, sourcePath, baseDir),
      scope,
      sourcePath,
      description: summarizePrompt(raw),
      prompt,
    }
  } catch {
    return null
  }
}

async function loadPluginCommandFiles(
  cwd: string,
  config?: NexusConfig,
): Promise<Array<{ command: LoadedSlashCommand; priority: number }>> {
  if (!config) return []
  const plugins = await loadTrustedPluginRuntimeRecords(cwd, config)
  const loaded: Array<{ command: LoadedSlashCommand; priority: number }> = []
  for (const plugin of plugins) {
    for (const declared of plugin.commands) {
      const declaredPath = resolvePluginDeclaredPath(plugin, declared)
      const stats = await fs.stat(declaredPath).catch(() => null)
      const files = stats?.isDirectory()
        ? await glob(path.join(declaredPath, "**", "*.md"), { absolute: true })
        : stats?.isFile() && declaredPath.toLowerCase().endsWith(".md")
          ? [declaredPath]
          : []
      const baseDir = stats?.isDirectory() ? declaredPath : path.dirname(declaredPath)
      for (const file of files.sort()) {
        const command = await readCommandFile(file, "project", baseDir)
        if (!command) continue
        const relative = path.relative(baseDir, file).replace(/\\/g, "/").replace(/\.md$/i, "")
        loaded.push({
          command: {
            ...command,
            command: `plugin:${plugin.name}:${relative}`,
            scope: "plugin",
            pluginName: plugin.name,
          },
          priority: plugin.scope === "project" ? 6 : 5,
        })
      }
    }
    for (const entry of plugin.commandEntries ?? []) {
      if (!entry.content) continue
      loaded.push({
        command: {
          command: `plugin:${plugin.name}:${entry.name}`,
          scope: "plugin",
          sourcePath: `${plugin.sourcePath}#commands.${entry.name}`,
          description: entry.description?.trim() || summarizePrompt(entry.content),
          prompt: entry.content,
          pluginName: plugin.name,
        },
        priority: plugin.scope === "project" ? 6 : 5,
      })
    }
  }
  return loaded
}

export async function loadSlashCommands(
  cwd: string,
  compatibility?: ClaudeCompatibilityOptions,
  config?: NexusConfig,
): Promise<LoadedSlashCommand[]> {
  const projectNexusDir = path.join(path.resolve(cwd), ".nexus", "commands")
  const globalNexusDir = path.join(os.homedir(), ".nexus", "commands")
  const dirs: Array<{ dir: string; scope: "project" | "user"; priority: number }> = [
    { dir: globalNexusDir, scope: "user", priority: 3 },
    { dir: projectNexusDir, scope: "project", priority: 4 },
  ]
  if (compatibility?.includeGlobalDir && compatibility?.includeCommands) {
    dirs.unshift({ dir: path.join(os.homedir(), ".claude", "commands"), scope: "user", priority: 1 })
  }
  if (compatibility?.includeProjectDir && compatibility?.includeCommands) {
    dirs.splice(1, 0, { dir: path.join(path.resolve(cwd), ".claude", "commands"), scope: "project", priority: 2 })
  }

  const all = await Promise.all(dirs.map(async ({ dir, scope, priority }) => {
    const files = await glob(path.join(dir, "**", "*.md"), { absolute: true }).catch(() => [] as string[])
    const loaded = await Promise.all(files.sort().map((file) => readCommandFile(file, scope, dir)))
    return loaded.map((command) => command ? { command, priority } : null)
  }))

  const pluginCommands = await loadPluginCommandFiles(cwd, config)
  const byName = new Map<string, { command: LoadedSlashCommand; priority: number }>()
  for (const item of [...all.flat(), ...pluginCommands].filter(
    (entry): entry is { command: LoadedSlashCommand; priority: number } => Boolean(entry),
  )) {
    const existing = byName.get(item.command.command)
    if (!existing || existing.priority <= item.priority) {
      byName.set(item.command.command, item)
    }
  }
  return Array.from(byName.values())
    .map(({ command }) => command)
    .sort((a, b) => a.command.localeCompare(b.command))
}

/**
 * Resolve a slash command consistently across CLI and editor surfaces.
 * Canonical names always win. Project commands shadow user commands, while a
 * plugin basename is accepted only when exactly one plugin contributes it.
 */
export function resolveSlashCommand(
  commands: LoadedSlashCommand[],
  requestedName: string,
): SlashCommandResolution {
  const name = requestedName.replace(/^\//, "").trim()
  if (!name) return { status: "not-found" }

  const exact = commands.find((item) => item.command === name)
  if (exact) return { status: "resolved", command: exact }

  for (const scopedName of [`project:${name}`, `user:${name}`]) {
    const scoped = commands.find((item) => item.command === scopedName)
    if (scoped) return { status: "resolved", command: scoped }
  }

  const pluginMatches = commands.filter(
    (item) => item.scope === "plugin" && item.command.endsWith(`:${name}`),
  )
  if (pluginMatches.length === 1) {
    return { status: "resolved", command: pluginMatches[0]! }
  }
  if (pluginMatches.length > 1) {
    return {
      status: "ambiguous",
      candidates: pluginMatches.map((item) => item.command).sort(),
    }
  }
  return { status: "not-found" }
}

function parseCommandArguments(args: string): string[] {
  const values: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let escaped = false
  let started = false
  for (const char of args) {
    if (escaped) {
      current += char
      escaped = false
      started = true
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        values.push(current)
        current = ""
        started = false
      }
      continue
    }
    current += char
    started = true
  }
  if (escaped) current += "\\"
  if (started) values.push(current)
  return values
}

export function renderSlashCommandPrompt(command: LoadedSlashCommand, args: string): string {
  const trimmedArgs = args.trim()
  const positional = parseCommandArguments(trimmedArgs)
  let replaced = false
  const rendered = command.prompt.replace(
    /\{\{args\}\}|\$ARGUMENTS\[(\d+)\]|\$(\d+)(?!\w)|\$ARGUMENTS/g,
    (placeholder, indexed: string | undefined, shorthand: string | undefined) => {
      replaced = true
      if (placeholder === "{{args}}" || placeholder === "$ARGUMENTS") return trimmedArgs
      const index = Number(indexed ?? shorthand)
      return positional[index] ?? ""
    },
  )
  if (replaced || !trimmedArgs) return rendered
  return `${command.prompt.trim()}\n\nUser arguments:\n${trimmedArgs}`
}
