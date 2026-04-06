import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { glob } from "glob"
import type { ClaudeCompatibilityOptions } from "../compat/claude.js"

export interface LoadedSlashCommand {
  command: string
  scope: "project" | "user"
  sourcePath: string
  description: string
  prompt: string
}

function buildCommandName(scope: "project" | "user", sourcePath: string, baseDir: string): string {
  const rel = path.relative(baseDir, sourcePath).replace(/\\/g, "/").replace(/\.md$/i, "")
  return `${scope}:${rel}`
}

function summarizePrompt(text: string): string {
  const cleaned = text.replace(/^---[\s\S]*?---\s*/m, "").trim()
  const first = cleaned.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ""
  return first.replace(/^#+\s*/, "").slice(0, 160) || "Custom slash command"
}

async function readCommandFile(sourcePath: string, scope: "project" | "user", baseDir: string): Promise<LoadedSlashCommand | null> {
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

export async function loadSlashCommands(cwd: string, compatibility?: ClaudeCompatibilityOptions): Promise<LoadedSlashCommand[]> {
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

  const byName = new Map<string, { command: LoadedSlashCommand; priority: number }>()
  for (const item of all.flat().filter((entry): entry is { command: LoadedSlashCommand; priority: number } => Boolean(entry))) {
    const existing = byName.get(item.command.command)
    if (!existing || existing.priority <= item.priority) {
      byName.set(item.command.command, item)
    }
  }
  return Array.from(byName.values())
    .map(({ command }) => command)
    .sort((a, b) => a.command.localeCompare(b.command))
}

export function renderSlashCommandPrompt(command: LoadedSlashCommand, args: string): string {
  const trimmedArgs = args.trim()
  if (command.prompt.includes("{{args}}")) {
    return command.prompt.replace(/\{\{args\}\}/g, trimmedArgs)
  }
  if (!trimmedArgs) return command.prompt
  return `${command.prompt.trim()}\n\nUser arguments:\n${trimmedArgs}`
}
