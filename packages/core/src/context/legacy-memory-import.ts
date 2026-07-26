import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { glob } from "glob"
import type { OrchestrationRuntime } from "../orchestration/runtime.js"
import type { MemoryRecord, NexusConfig } from "../types.js"
import { resolveAutoMemoryDirectory } from "./auto-memory.js"

const MAX_FILES = 100
const MAX_FILE_CHARS = 24_000
const MAX_TOTAL_CHARS = 256_000

export interface LegacyMemoryImportResult {
  imported: number
  unchanged: number
  skipped: number
  truncated: boolean
}

function safeTeamDirSegment(name: string): string {
  return encodeURIComponent(name.trim().slice(0, 120) || "default")
}

function within(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function markdownFiles(base: string): Promise<string[]> {
  const resolvedBase = await fs.realpath(base).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (!resolvedBase) return []
  const matches = await glob(path.join(resolvedBase, "**/*.md"), { nodir: true })
  const files: string[] = []
  for (const match of matches.sort()) {
    const real = await fs.realpath(match).catch(() => null)
    if (real && within(resolvedBase, real)) files.push(real)
  }
  return files
}

type Candidate = {
  scope: "project" | "team"
  title: string
  content: string
  source: MemoryRecord["source"]
  metadata: Record<string, unknown>
}

/**
 * Migrate OpenClaude-style Markdown memory into the canonical transactional
 * store. Files are treated as opaque, untrusted data: @include directives are
 * deliberately not expanded.
 */
export async function importLegacyMemoryFiles(input: {
  cwd: string
  config: NexusConfig
  runtime: OrchestrationRuntime
  homeDir?: string
}): Promise<LegacyMemoryImportResult> {
  const candidates: Candidate[] = []
  const autoBase = resolveAutoMemoryDirectory(input.cwd, input.config)
  if (autoBase) {
    for (const file of await markdownFiles(autoBase)) {
      candidates.push({
        scope: "project",
        title: `Legacy project memory: ${path.relative(autoBase, file).replaceAll("\\", "/")}`,
        content: await fs.readFile(file, "utf8"),
        source: { type: "legacy_file", uri: file, importedAt: Date.now() },
        metadata: { legacyMemoryUri: file, legacyMemoryType: "auto" },
      })
    }
  }

  if (input.config.memory?.teamMemoryEnabled !== false) {
    const nexusHome = path.resolve(input.homeDir ?? path.join(os.homedir(), ".nexus"))
    for (const team of await input.runtime.listTeams()) {
      const base = path.join(nexusHome, "teams", safeTeamDirSegment(team.name), "memory")
      for (const file of await markdownFiles(base)) {
        candidates.push({
          scope: "team",
          title: `Legacy team memory: ${team.name} / ${path.relative(base, file).replaceAll("\\", "/")}`,
          content: await fs.readFile(file, "utf8"),
          source: { type: "legacy_file", uri: file, importedAt: Date.now() },
          metadata: { legacyMemoryUri: file, legacyMemoryType: "team", teamName: team.name },
        })
      }
    }
  }

  const existing = await input.runtime.listMemories()
  const byUri = new Map(
    existing
      .filter((memory) => typeof memory.metadata?.legacyMemoryUri === "string")
      .map((memory) => [memory.metadata!.legacyMemoryUri as string, memory]),
  )
  let imported = 0
  let unchanged = 0
  let skipped = 0
  let totalChars = 0
  let truncated = false
  for (const candidate of candidates) {
    if (imported + unchanged >= MAX_FILES) {
      skipped += 1
      truncated = true
      continue
    }
    const content = candidate.content.trim().slice(0, MAX_FILE_CHARS)
    if (!content) {
      skipped += 1
      continue
    }
    if (totalChars + content.length > MAX_TOTAL_CHARS) {
      skipped += 1
      truncated = true
      continue
    }
    totalChars += content.length
    const previous = byUri.get(candidate.source.uri!)
    if (
      previous &&
      previous.title === candidate.title &&
      previous.content === content &&
      previous.scope === candidate.scope
    ) {
      unchanged += 1
      continue
    }
    await input.runtime.upsertMemoryByTitle({
      scope: candidate.scope,
      title: candidate.title,
      content,
      kind: "fact",
      source: candidate.source,
      author: { type: "external" },
      trust: "external",
      confidence: 0.6,
      metadata: candidate.metadata,
    })
    imported += 1
  }
  return { imported, unchanged, skipped, truncated }
}
