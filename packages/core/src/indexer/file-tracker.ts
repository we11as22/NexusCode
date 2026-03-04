import * as fs from "node:fs/promises"
import * as path from "node:path"

export interface FileRecord {
  mtime: number
  hash: string
  chunks?: number
}

/**
 * Lightweight file tracker for incremental vector indexing.
 * Tracks path -> mtime/hash/chunk count so unchanged files are skipped.
 */
export class FileTracker {
  private filePath: string
  private data: Record<string, FileRecord> = {}
  private dirty = false

  constructor(indexDir: string) {
    this.filePath = path.join(indexDir, "file-tracker.json")
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
      out.set(p, { mtime: r.mtime, hash: r.hash, chunks: r.chunks })
    }
    return out
  }

  isFileIndexed(filePath: string, mtime: number, hash: string): boolean {
    const r = this.data[filePath]
    return r !== undefined && r.hash === hash && r.mtime === mtime
  }

  upsertFile(filePath: string, mtime: number, hash: string, chunks?: number): void {
    this.data[filePath] = { mtime, hash, chunks }
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

  clear(): void {
    this.data = {}
    this.dirty = true
  }
}
