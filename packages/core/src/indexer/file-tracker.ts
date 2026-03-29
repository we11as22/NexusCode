import * as fs from "node:fs/promises"
import * as path from "node:path"

export interface FileRecord {
  /** Preferred: SHA-256 of full file content (hex). */
  contentSha256?: string
  /** Legacy MD5/mtime-based records — treated as stale until reindexed. */
  mtime?: number
  hash?: string
  chunks?: number
}

/**
 * Lightweight file tracker for incremental vector indexing (Roo-style content hash).
 */
export class FileTracker {
  private filePath: string
  private data: Record<string, FileRecord> = {}
  private dirty = false

  /**
   * @param indexDir Default index directory (for `file-tracker.json` when `explicitJsonPath` omitted).
   * @param explicitJsonPath Roo-style absolute path (e.g. VS Code `globalStorageUri`) for the tracker JSON.
   */
  constructor(indexDir: string, explicitJsonPath?: string) {
    this.filePath = explicitJsonPath ?? path.join(indexDir, "file-tracker.json")
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8")
      const parsed = JSON.parse(raw) as Record<string, FileRecord>
      if (parsed && typeof parsed === "object") {
        this.data = parsed
      }
    } catch {
      this.data = {}
    }
    this.dirty = false
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(this.data), "utf8")
    this.dirty = false
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
    this.data[filePath] = { contentSha256, chunks }
    this.dirty = true
  }

  getChunks(filePath: string): number | undefined {
    const chunks = this.data[filePath]?.chunks
    return typeof chunks === "number" && Number.isFinite(chunks) && chunks >= 0 ? chunks : undefined
  }

  deleteFile(filePath: string): void {
    if (this.data[filePath] !== undefined) {
      delete this.data[filePath]
      this.dirty = true
    }
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
    this.dirty = true
  }
}
