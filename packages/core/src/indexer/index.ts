import * as path from "node:path"
import * as fs from "node:fs/promises"
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
  private debounceTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly projectRoot: string,
    private readonly config: NexusConfig,
    embeddingClient?: EmbeddingClient,
    vectorUrl?: string,
    projectHash?: string
  ) {
    const indexDir = getIndexDir(projectRoot)
    const { mkdirSync } = require("node:fs")
    mkdirSync(indexDir, { recursive: true })

    this.fts = new FTSIndex(path.join(indexDir, "fts.db"))

    if (config.vectorDb?.enabled && embeddingClient && vectorUrl && projectHash) {
      this.vector = new VectorIndex(vectorUrl, projectHash, embeddingClient)
    }
  }

  status(): IndexStatus {
    return this._status
  }

  async startIndexing(): Promise<void> {
    if (this.indexing) return
    this.indexing = true
    this.abortController = new AbortController()

    // Init vector if enabled
    if (this.vector) {
      try {
        await this.vector.init()
      } catch (err) {
        console.warn("[nexus] Vector index init failed:", err)
        this.vector = undefined
      }
    }

    this._status = { state: "indexing", progress: 0, total: 0 }

    this.indexInBackground().catch(err => {
      console.warn("[nexus] Indexing error:", err)
      this._status = { state: "error", error: (err as Error).message }
      this.indexing = false
    })
  }

  private async indexInBackground(): Promise<void> {
    const existing = this.fts.getFilesWithHashes()
    const seen = new Set<string>()
    let processed = 0

    // Count files first for progress
    let total = 0
    for await (const _ of walkDir(this.projectRoot, this.config.indexing.excludePatterns)) {
      total++
      if (this.abortController?.signal.aborted) break
    }

    this._status = { state: "indexing", progress: 0, total }

    const batchSize = this.config.indexing.batchSize
    let batch: FileInfo[] = []

    for await (const file of walkDir(this.projectRoot, this.config.indexing.excludePatterns)) {
      if (this.abortController?.signal.aborted) break

      seen.add(file.path)
      batch.push(file)

      if (batch.length >= batchSize) {
        await this.processBatch(batch)
        processed += batch.length
        this._status = { state: "indexing", progress: processed, total }
        batch = []
        // Yield to event loop between batches
        await new Promise(r => setImmediate(r))
      }
    }

    if (batch.length > 0) {
      await this.processBatch(batch)
      processed += batch.length
    }

    // Delete removed files
    for (const [filePath] of existing) {
      if (!seen.has(filePath)) {
        this.fts.deleteFile(filePath)
        await this.vector?.deleteByPath(filePath)
      }
    }

    const stats = this.fts.getStats()
    this._status = { state: "ready", files: stats.files, symbols: stats.symbols }
    this.indexing = false
  }

  private async processBatch(files: FileInfo[]): Promise<void> {
    const vectorEntries: Parameters<VectorIndex["upsertSymbols"]>[0] = []

    for (const file of files) {
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
        // Fallback: chunk by lines
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
    // Debounce
    const existing = this.debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath)
      await this.processBatch([
        await buildFileInfo(filePath, this.projectRoot).catch(() => null),
      ].filter(Boolean) as any[])
    }, this.config.indexing.debounceMs)

    this.debounceTimers.set(filePath, timer)
  }

  async search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]> {
    const limit = opts?.limit ?? 10
    const kind = opts?.kind

    const results: IndexSearchResult[] = []

    // FTS search
    if (this.config.indexing.fts) {
      const symbolResults = this.fts.searchSymbols(query, limit, kind)
      results.push(...symbolResults)

      if (results.length < limit) {
        const chunkResults = this.fts.searchChunks(query, limit - results.length)
        results.push(...chunkResults)
      }
    }

    // Vector search (merge if available)
    if (this.vector && this.config.indexing.vector && opts?.semantic !== false) {
      const vecResults = await this.vector.search(query, limit, kind)

      // Merge and deduplicate by path+line
      const seen = new Set(results.map(r => `${r.path}:${r.startLine}`))
      for (const r of vecResults) {
        const key = `${r.path}:${r.startLine}`
        if (!seen.has(key)) {
          seen.add(key)
          results.push(r)
        }
      }
    }

    // Sort by score (lower FTS rank = better, higher vector score = better)
    return results
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit)
  }

  stop(): void {
    this.abortController?.abort()
  }
}

async function buildFileInfo(absPath: string, root: string): Promise<{
  path: string; absPath: string; ext: string; mtime: number; hash: string; size: number
} | null> {
  try {
    const { stat, readFile } = await import("node:fs/promises")
    const { createHash } = await import("node:crypto")
    const { extname, relative } = await import("node:path")

    const s = await stat(absPath)
    const content = await readFile(absPath)
    const hash = createHash("md5").update(content).digest("hex")

    return {
      path: relative(root, absPath),
      absPath,
      ext: extname(absPath).toLowerCase(),
      mtime: s.mtimeMs,
      hash,
      size: s.size,
    }
  } catch {
    return null
  }
}

export { CodebaseIndexer as default }
