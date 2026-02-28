import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as crypto from "node:crypto"
import { mkdirSync } from "node:fs"
import type { IIndexer, IndexStatus, IndexSearchOptions, IndexSearchResult, NexusConfig } from "../types.js"
import type { FileInfo } from "./scanner.js"
import { FTSIndex } from "./fts.js"
import { VectorIndex } from "./vector.js"
import { walkDir } from "./scanner.js"
import { extractSymbols, extractChunks } from "./ast-extractor.js"
import { getIndexDir } from "./multi-project.js"
import type { EmbeddingClient } from "../provider/types.js"

const SUPPORTED_CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
])

/**
 * Main codebase indexer. Manages FTS and optional vector index.
 */
export class CodebaseIndexer implements IIndexer {
  private fts: FTSIndex
  private vector?: VectorIndex
  private _status: IndexStatus = { state: "idle" }
  private indexing = false
  private abortController?: AbortController
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private statusListeners: Array<(status: IndexStatus) => void> = []

  constructor(
    private readonly projectRoot: string,
    private readonly config: NexusConfig,
    embeddingClient?: EmbeddingClient,
    vectorUrl?: string,
    projectHash?: string
  ) {
    const indexDir = getIndexDir(projectRoot)
    mkdirSync(indexDir, { recursive: true })

    this.fts = new FTSIndex(path.join(indexDir, "fts.db"))

    if (config.vectorDb?.enabled && embeddingClient && vectorUrl && projectHash) {
      this.vector = new VectorIndex(vectorUrl, projectHash, embeddingClient)
    }
  }

  status(): IndexStatus {
    return this._status
  }

  onStatusChange(listener: (status: IndexStatus) => void): () => void {
    this.statusListeners.push(listener)
    return () => {
      this.statusListeners = this.statusListeners.filter(l => l !== listener)
    }
  }

  private notifyStatus(status: IndexStatus): void {
    this._status = status
    for (const listener of this.statusListeners) {
      try { listener(status) } catch {}
    }
  }

  async startIndexing(): Promise<void> {
    if (this.indexing) {
      // If already indexing, restart cleanly
      this.stop()
      await new Promise<void>(r => setTimeout(r, 100))
    }
    this.indexing = true
    this.abortController = new AbortController()

    if (this.vector) {
      try {
        await this.vector.init()
      } catch (err) {
        console.warn("[nexus] Vector index init failed:", err)
        this.vector = undefined
      }
    }

    this.notifyStatus({ state: "indexing", progress: 0, total: 0 })

    this.indexInBackground().catch(err => {
      console.warn("[nexus] Indexing error:", err)
      this.notifyStatus({ state: "error", error: (err as Error).message })
      this.indexing = false
    })
  }

  private async indexInBackground(): Promise<void> {
    const existing = this.fts.getFilesWithHashes()
    const seen = new Set<string>()
    let processed = 0
    let total = 0

    const batchSize = this.config.indexing.batchSize
    let batch: FileInfo[] = []

    // Single-pass: walk + process in one traversal
    for await (const file of walkDir(this.projectRoot, this.config.indexing.excludePatterns)) {
      if (this.abortController?.signal.aborted) break

      total++
      seen.add(file.path)
      batch.push(file)

      if (batch.length >= batchSize) {
        await this.processBatch(batch)
        processed += batch.length
        this.notifyStatus({ state: "indexing", progress: processed, total })
        batch = []
        // Yield to event loop between batches to avoid blocking
        await new Promise<void>(r => setImmediate(r))
      }
    }

    if (batch.length > 0 && !this.abortController?.signal.aborted) {
      await this.processBatch(batch)
      processed += batch.length
    }

    if (this.abortController?.signal.aborted) {
      this.indexing = false
      return
    }

    // Remove files that no longer exist
    for (const [filePath] of existing) {
      if (!seen.has(filePath)) {
        this.fts.deleteFile(filePath)
        await this.vector?.deleteByPath(filePath)
      }
    }

    const stats = this.fts.getStats()
    this.notifyStatus({ state: "ready", files: stats.files, symbols: stats.symbols })
    this.indexing = false
  }

  private async processBatch(files: FileInfo[]): Promise<void> {
    const vectorEntries: Parameters<VectorIndex["upsertSymbols"]>[0] = []

    for (const file of files) {
      if (!file) continue

      // Skip if unchanged
      if (this.fts.isFileIndexed(file.path, file.mtime, file.hash)) continue

      let content: string
      try {
        content = await fs.readFile(file.absPath, "utf8")
      } catch {
        continue
      }

      this.fts.upsertFile(file.path, file.mtime, file.hash)

      if (SUPPORTED_CODE_EXTENSIONS.has(file.ext) && this.config.indexing.symbolExtract) {
        const symbols = extractSymbols(content, file.path, file.ext)
        for (const sym of symbols) {
          this.fts.insertSymbol(sym)
          if (this.vector && this.config.indexing.vector) {
            const id = `${file.hash}_${sym.startLine}`
            vectorEntries.push({
              id,
              path: file.path,
              name: sym.name,
              kind: sym.kind,
              parent: sym.parent,
              startLine: sym.startLine,
              content: sym.content,
            })
          }
        }
      } else {
        // Fallback: chunk by lines with overlap
        const chunks = extractChunks(content, file.path)
        for (const chunk of chunks) {
          this.fts.insertChunk({ path: chunk.path, offset: chunk.startLine, content: chunk.content })
        }
      }
    }

    if (vectorEntries.length > 0) {
      await this.vector?.upsertSymbols(vectorEntries)
    }
  }

  async refreshFile(filePath: string): Promise<void> {
    const existing = this.debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath)

      // Check if file still exists
      const fileInfo = await buildFileInfo(filePath, this.projectRoot)
      if (!fileInfo) {
        // File deleted — remove from index
        const relPath = path.relative(this.projectRoot, filePath)
        this.fts.deleteFile(relPath)
        await this.vector?.deleteByPath(relPath)
        return
      }

      await this.processBatch([fileInfo])
    }, this.config.indexing.debounceMs)

    this.debounceTimers.set(filePath, timer)
  }

  async search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]> {
    const limit = opts?.limit ?? 10
    const kind = opts?.kind

    const results: IndexSearchResult[] = []

    if (this.config.indexing.fts) {
      const symbolResults = this.fts.searchSymbols(query, limit, kind)
      results.push(...symbolResults)

      if (results.length < limit) {
        const chunkResults = this.fts.searchChunks(query, limit - results.length)
        results.push(...chunkResults)
      }
    }

    if (this.vector && this.config.indexing.vector && opts?.semantic !== false) {
      const vecResults = await this.vector.search(query, limit, kind)

      const seen = new Set(results.map(r => `${r.path}:${r.startLine}`))
      for (const r of vecResults) {
        const key = `${r.path}:${r.startLine}`
        if (!seen.has(key)) {
          seen.add(key)
          results.push(r)
        }
      }
    }

    return results
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
  }

  /**
   * Clear all index data and restart indexing.
   */
  async reindex(): Promise<void> {
    this.stop()
    this.fts.clear()
    await this.startIndexing()
  }

  stop(): void {
    this.abortController?.abort()
    this.indexing = false

    // Clear all pending debounce timers to prevent post-stop callbacks
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
  }

  /**
   * Fully close the indexer — clears timers, closes SQLite.
   * Call when the extension is deactivated or the indexer is no longer needed.
   */
  close(): void {
    this.stop()
    this.statusListeners = []
    try {
      this.fts.close()
    } catch {}
  }
}

async function buildFileInfo(absPath: string, root: string): Promise<FileInfo | null> {
  try {
    const s = await fs.stat(absPath)
    const content = await fs.readFile(absPath)
    const hash = crypto.createHash("md5").update(content).digest("hex")
    const ext = path.extname(absPath).toLowerCase()

    return {
      path: path.relative(root, absPath),
      absPath,
      ext,
      mtime: s.mtimeMs,
      hash,
      size: s.size,
    }
  } catch {
    return null
  }
}

export { CodebaseIndexer as default }
