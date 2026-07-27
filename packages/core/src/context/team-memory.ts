import * as path from "node:path"
import * as os from "node:os"
import { OrchestrationRuntime } from "../orchestration/runtime.js"
import type { NexusConfig } from "../types.js"
import { collectMemoryMarkdownFiles } from "./memory-files.js"
import { redactMemorySecrets } from "../memory/index.js"

const MAX_TEAM_MEMORY_TEAMS = 32
const MAX_TEAM_MEMORY_FILES = 128
const MAX_TEAM_MEMORY_TOTAL_CHARS = 512 * 1024

function safeTeamDirSegment(name: string): string {
  return encodeURIComponent(name.trim().slice(0, 120) || "default")
}

/**
 * Optional team-scoped markdown under ~/.nexus/teams/{name}/memory/ (recursive .md files).
 */
export async function loadTeamMemoryMarkdown(
  cwd: string,
  config: NexusConfig,
  ownedRuntime?: OrchestrationRuntime,
): Promise<string> {
  if (config.memory?.teamMemoryEnabled === false) return ""

  const runtime = ownedRuntime ?? new OrchestrationRuntime(cwd)

  const teams = await runtime.listTeams().catch(() => [])
  if (teams.length === 0) return ""

  const home = os.homedir()
  const chunks: string[] = []
  let fileCount = 0
  let totalChars = 0
  let omitted = teams.length > MAX_TEAM_MEMORY_TEAMS

  for (const team of teams.slice(0, MAX_TEAM_MEMORY_TEAMS)) {
    const name = typeof team.name === "string" ? team.name : ""
    if (!name.trim()) continue
    const base = path.join(home, ".nexus", "teams", safeTeamDirSegment(name), "memory")
    const remainingFiles = MAX_TEAM_MEMORY_FILES - fileCount
    const remainingChars = MAX_TEAM_MEMORY_TOTAL_CHARS - totalChars
    if (remainingFiles <= 0 || remainingChars <= 0) {
      omitted = true
      break
    }
    const collection = await collectMemoryMarkdownFiles(base, {
      maxDepth: 8,
      maxFiles: remainingFiles,
      maxEntries: 4_096,
      maxFileBytes: 128 * 1024,
      maxTotalChars: remainingChars,
    })
    if (collection.omitted) omitted = true
    for (const file of collection.files) {
      const header =
        `<!-- team-memory (untrusted, includes not expanded): ` +
        `${name} / ${file.relativePath} -->\n`
      const marker = file.truncated ? "\n[team-memory file truncated]\n" : ""
      const available = MAX_TEAM_MEMORY_TOTAL_CHARS - totalChars
      const safeContent = redactMemorySecrets(file.content).text
      const chunk = `${header}${safeContent}${marker}`.slice(0, available)
      if (!chunk.trim()) continue
      chunks.push(chunk)
      fileCount += 1
      totalChars += chunk.length
      if (
        chunk.length < header.length + safeContent.length + marker.length
      ) {
        omitted = true
        break
      }
    }
  }

  if (omitted) {
    chunks.push(
      "<!-- additional team-memory content omitted by safety limits -->",
    )
  }
  return chunks.join("\n\n")
}
