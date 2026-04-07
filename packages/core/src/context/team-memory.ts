import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { glob } from "glob"
import { getOrchestrationRuntime } from "../orchestration/runtime.js"
import type { NexusConfig } from "../types.js"
import { expandInstructionIncludes } from "./instruction-include.js"

function safeTeamDirSegment(name: string): string {
  return encodeURIComponent(name.trim().slice(0, 120) || "default")
}

/**
 * Optional team-scoped markdown under ~/.nexus/teams/{name}/memory/ (recursive .md files).
 */
export async function loadTeamMemoryMarkdown(cwd: string, config: NexusConfig): Promise<string> {
  if (config.memory?.teamMemoryEnabled === false) return ""

  const runtime = await getOrchestrationRuntime(cwd).catch(() => null)
  if (!runtime) return ""

  const teams = await runtime.listTeams().catch(() => [])
  if (teams.length === 0) return ""

  const home = os.homedir()
  const chunks: string[] = []

  for (const team of teams) {
    const name = typeof team.name === "string" ? team.name : ""
    if (!name.trim()) continue
    const base = path.join(home, ".nexus", "teams", safeTeamDirSegment(name), "memory")
    const files = await glob(path.join(base, "**/*.md")).catch(() => [] as string[])
    for (const f of files.sort()) {
      const raw = await fs.readFile(f, "utf8").catch(() => "")
      if (!raw.trim()) continue
      const expanded = await expandInstructionIncludes(raw, path.dirname(f), new Set())
      chunks.push(`<!-- team-memory: ${name} / ${path.relative(base, f).replace(/\\/g, "/")} -->\n${expanded}`)
    }
  }

  return chunks.join("\n\n")
}
