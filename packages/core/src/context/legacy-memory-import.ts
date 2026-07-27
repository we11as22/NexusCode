import * as os from "node:os"
import * as path from "node:path"
import type { OrchestrationRuntime } from "../orchestration/runtime.js"
import type { MemoryRecord, NexusConfig } from "../types.js"
import { resolveAutoMemoryDirectory } from "./auto-memory.js"
import { collectMemoryMarkdownFiles } from "./memory-files.js"

const MAX_FILES = 100
const MAX_FILE_CHARS = 24_000
const MAX_TOTAL_CHARS = 256_000

export interface LegacyMemoryImportResult {
  imported: number
  unchanged: number
  removed: number
  skipped: number
  truncated: boolean
}

function safeTeamDirSegment(name: string): string {
  return encodeURIComponent(name.trim().slice(0, 120) || "default")
}

type Candidate = {
  scope: "project" | "team"
  kind: MemoryRecord["kind"]
  title: string
  content: string
  source: MemoryRecord["source"]
  author: MemoryRecord["author"]
  trust: MemoryRecord["trust"]
  confidence: number
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
  let scanTruncated = false
  let scannedChars = 0
  const addMemoryDirectory = async (
    base: string,
    build: (
      file: Awaited<ReturnType<typeof collectMemoryMarkdownFiles>>["files"][number],
    ) => Candidate,
  ): Promise<boolean> => {
    const remainingFiles = MAX_FILES - candidates.length
    const remainingChars = MAX_TOTAL_CHARS - scannedChars
    if (remainingFiles <= 0 || remainingChars <= 0) {
      scanTruncated = true
      return false
    }
    const collection = await collectMemoryMarkdownFiles(base, {
      maxDepth: 8,
      maxFiles: remainingFiles,
      maxEntries: 4_096,
      maxFileBytes: MAX_FILE_CHARS,
      maxTotalChars: remainingChars,
    })
    if (collection.omitted) scanTruncated = true
    for (const file of collection.files) {
      candidates.push(build(file))
      scannedChars += file.content.length
      if (file.truncated) scanTruncated = true
    }
    return !collection.omitted
  }

  const autoBase = resolveAutoMemoryDirectory(input.cwd, input.config)
  let autoScanComplete = input.config.memory?.autoMemoryEnabled === false
  if (autoBase) {
    autoScanComplete = await addMemoryDirectory(autoBase, (file) => {
      const consolidated =
        file.relativePath === "_nexus_consolidated_memory.md"
      return {
        scope: "project",
        kind: consolidated ? "summary" : "fact",
        title: consolidated
          ? "Consolidated project memory"
          : `Legacy project memory: ${file.relativePath}`,
        content: file.content,
        source: {
          type: consolidated ? "compaction" : "legacy_file",
          uri: file.path,
          importedAt: Date.now(),
        },
        author: { type: consolidated ? "agent" : "external" },
        trust: consolidated ? "agent" : "external",
        confidence: consolidated ? 0.7 : 0.6,
        metadata: { legacyMemoryUri: file.path, legacyMemoryType: "auto" },
      }
    })
  }

  let teamScanComplete = input.config.memory?.teamMemoryEnabled === false
  if (input.config.memory?.teamMemoryEnabled !== false) {
    teamScanComplete = true
    const nexusHome = path.resolve(input.homeDir ?? path.join(os.homedir(), ".nexus"))
    for (const team of await input.runtime.listTeams()) {
      const base = path.join(nexusHome, "teams", safeTeamDirSegment(team.name), "memory")
      const complete = await addMemoryDirectory(base, (file) => ({
          scope: "team",
          kind: "fact",
          title: `Legacy team memory: ${team.name} / ${file.relativePath}`,
          content: file.content,
          source: {
            type: "legacy_file",
            uri: file.path,
            importedAt: Date.now(),
          },
          author: { type: "external" },
          trust: "external",
          confidence: 0.6,
          metadata: {
            legacyMemoryUri: file.path,
            legacyMemoryType: "team",
            teamName: team.name,
          },
        }))
      if (!complete) teamScanComplete = false
      if (candidates.length >= MAX_FILES || scannedChars >= MAX_TOTAL_CHARS) {
        scanTruncated = true
        teamScanComplete = false
        break
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
  let removed = 0
  let skipped = 0
  let totalChars = 0
  let truncated = scanTruncated
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
      kind: candidate.kind,
      source: candidate.source,
      author: candidate.author,
      trust: candidate.trust,
      confidence: candidate.confidence,
      metadata: candidate.metadata,
    })
    imported += 1
  }

  const desiredUrisByType = {
    auto: new Set<string>(),
    team: new Set<string>(),
  }
  for (const candidate of candidates) {
    const uri = candidate.source.uri
    const type = candidate.metadata.legacyMemoryType
    if (
      uri &&
      (type === "auto" || type === "team")
    ) {
      desiredUrisByType[type].add(uri)
    }
  }
  for (const memory of existing) {
    const type = memory.metadata?.legacyMemoryType
    const uri = memory.metadata?.legacyMemoryUri
    const projectionIsComplete =
      type === "auto"
        ? autoScanComplete
        : type === "team"
          ? teamScanComplete
          : false
    if (
      projectionIsComplete &&
      typeof uri === "string" &&
      (type === "auto" || type === "team") &&
      !desiredUrisByType[type].has(uri) &&
      await input.runtime.deleteMemory(memory.id)
    ) {
      removed += 1
    }
  }
  return { imported, unchanged, removed, skipped, truncated }
}
