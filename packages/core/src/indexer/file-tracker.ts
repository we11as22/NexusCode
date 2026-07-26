import * as path from "node:path"
import {
  atomicWriteJson,
  readJsonWithRecovery,
  withFileLock,
} from "../storage/durable-fs.js"

export interface FileRecord {
  /** Preferred: SHA-256 of full file content (hex). */
  contentSha256?: string
  /** Legacy MD5/mtime-based records — treated as stale until reindexed. */
  mtime?: number
  hash?: string
  chunks?: number
}

type TrackerMutation =
  | { type: "upsert"; filePath: string; record: FileRecord }
  | { type: "delete"; filePath: string }
  | { type: "deletePrefix"; prefix: string }
  | { type: "clear" }

function isFileRecord(value: unknown): value is FileRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as FileRecord
  return (
    (record.contentSha256 === undefined || typeof record.contentSha256 === "string") &&
    (record.mtime === undefined || typeof record.mtime === "number") &&
    (record.hash === undefined || typeof record.hash === "string") &&
    (record.chunks === undefined || typeof record.chunks === "number")
  )
}

function normalizeTrackerData(value: unknown): Record<string, FileRecord> {
  if (value == null) return {}
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid file tracker: expected an object.")
  }
  const normalized: Record<string, FileRecord> = {}
  for (const [filePath, record] of Object.entries(value)) {
    if (!isFileRecord(record)) {
      throw new Error(`Invalid file tracker record: ${filePath}`)
    }
    normalized[filePath] = record
  }
  return normalized
}

function applyMutations(
  initial: Record<string, FileRecord>,
  mutations: readonly TrackerMutation[],
): Record<string, FileRecord> {
  let data = { ...initial }
  for (const mutation of mutations) {
    if (mutation.type === "clear") {
      data = {}
    } else if (mutation.type === "upsert") {
      data[mutation.filePath] = mutation.record
    } else if (mutation.type === "delete") {
      delete data[mutation.filePath]
    } else {
      for (const filePath of Object.keys(data)) {
        if (
          filePath === mutation.prefix ||
          filePath.startsWith(`${mutation.prefix}/`)
        ) {
          delete data[filePath]
        }
      }
    }
  }
  return data
}

/**
 * Lightweight file tracker for incremental vector indexing (Roo-style content hash).
 */
export class FileTracker {
  private filePath: string
  private data: Record<string, FileRecord> = {}
  private dirty = false
  private pendingMutations: TrackerMutation[] = []

  /**
   * @param indexDir Default index directory (for `file-tracker.json` when `explicitJsonPath` omitted).
   * @param explicitJsonPath Roo-style absolute path (e.g. VS Code `globalStorageUri`) for the tracker JSON.
   */
  constructor(indexDir: string, explicitJsonPath?: string) {
    this.filePath = explicitJsonPath ?? path.join(indexDir, "file-tracker.json")
  }

  async load(): Promise<void> {
    const recovered = await readJsonWithRecovery<unknown>(this.filePath)
    const loaded = normalizeTrackerData(recovered.value)
    this.data = applyMutations(loaded, this.pendingMutations)
    this.dirty = this.pendingMutations.length > 0
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    await withFileLock(this.filePath, async () => {
      const mutationCount = this.pendingMutations.length
      if (mutationCount === 0) {
        this.dirty = false
        return
      }
      const mutations = this.pendingMutations.slice(0, mutationCount)
      const recovered = await readJsonWithRecovery<unknown>(this.filePath)
      const current = normalizeTrackerData(recovered.value)
      const merged = applyMutations(current, mutations)
      // When the primary was corrupt, preserve the known-good backup until the
      // recovered state has replaced it successfully.
      await atomicWriteJson(this.filePath, merged, {
        backup: recovered.source !== "backup",
      })
      this.pendingMutations.splice(0, mutationCount)
      this.data = applyMutations(merged, this.pendingMutations)
      this.dirty = this.pendingMutations.length > 0
    })
  }

  getFilesWithHashes(): Map<string, { mtime: number; hash: string; chunks?: number }> {
    const out = new Map<string, { mtime: number; hash: string; chunks?: number }>()
    for (const [p, r] of Object.entries(this.data)) {
      const h = r.contentSha256 ?? r.hash ?? ""
      const mt = typeof r.mtime === "number" ? r.mtime : 0
      out.set(p, { mtime: mt, hash: h, chunks: r.chunks })
    }
    return out
  }

  /**
   * True if this path is indexed for the same full-file content (SHA-256).
   */
  isFileIndexed(filePath: string, contentSha256: string): boolean {
    const r = this.data[filePath]
    if (!r?.contentSha256) return false
    return r.contentSha256 === contentSha256
  }

  upsertFile(filePath: string, contentSha256: string, chunks?: number): void {
    const record = { contentSha256, chunks }
    this.data[filePath] = record
    this.pendingMutations.push({ type: "upsert", filePath, record })
    this.dirty = true
  }

  getChunks(filePath: string): number | undefined {
    const chunks = this.data[filePath]?.chunks
    return typeof chunks === "number" && Number.isFinite(chunks) && chunks >= 0 ? chunks : undefined
  }

  deleteFile(filePath: string): void {
    delete this.data[filePath]
    this.pendingMutations.push({ type: "delete", filePath })
    this.dirty = true
  }

  /** Remove tracker entries for `prefix` and any path under `prefix/` (repo-relative, forward slashes). */
  deleteFilesUnderPrefix(prefix: string): void {
    const norm = prefix.replace(/\\/g, "/").replace(/\/+$/, "")
    if (!norm) {
      this.clear()
      return
    }
    for (const k of Object.keys(this.data)) {
      if (k === norm || k.startsWith(`${norm}/`)) {
        delete this.data[k]
        this.dirty = true
      }
    }
    this.pendingMutations.push({ type: "deletePrefix", prefix: norm })
    this.dirty = true
  }

  listPaths(): string[] {
    return Object.keys(this.data)
  }

  totalChunkCount(): number {
    let n = 0
    for (const r of Object.values(this.data)) {
      const c = r.chunks
      if (typeof c === "number" && c > 0) n += c
    }
    return n
  }

  clear(): void {
    this.data = {}
    this.pendingMutations.push({ type: "clear" })
    this.dirty = true
  }
}
