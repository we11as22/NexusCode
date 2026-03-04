import * as path from "node:path"
import * as fs from "node:fs/promises"
import * as crypto from "node:crypto"
import { mkdirSync } from "node:fs"
import pLimit from "p-limit"
import type { IIndexer, IndexStatus, IndexSearchOptions, IndexSearchResult, NexusConfig, SymbolEntry } from "../types.js"
import type { FileInfo } from "./scanner.js"
import { FileTracker } from "./file-tracker.js"
import { VectorIndex, VectorAuthError } from "./vector.js"
import { walkDir } from "./scanner.js"
import { extractSymbols, extractChunks } from "./ast-extractor.js"
import { getIndexDir } from "./multi-project.js"
import type { EmbeddingClient } from "../provider/types.js"

const SUPPORTED_CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
])
const SUPPORTED_MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"])
const SUPPORTED_INDEX_EXTENSIONS = new Set([
  ...SUPPORTED_CODE_EXTENSIONS,
  ...SUPPORTED_MARKDOWN_EXTENSIONS,
])

/** Concurrency for file parsing in Phase 1 (parallel read + extract). */
const PARSE_CONCURRENCY = 10

interface PreparedFile {
  file: FileInfo
  unchanged: boolean
  shouldUpdateVector: boolean
  extracted: SymbolEntry[]
}

/**
 * Codebase indexer: vector-only (Qdrant).
 * When vector client is missing, indexing is no-op and search returns [].
 */
export class CodebaseIndexer implements IIndexer {
  private fileTracker: FileTracker
  private vector?: VectorIndex
  private forceVectorBackfill = false
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
    this.fileTracker = new FileTracker(indexDir)

    if (config.vectorDb?.enabled && embeddingClient && vectorUrl && projectHash) {
      this.vector = new VectorIndex(vectorUrl, projectHash, embeddingClient, {
        embeddingBatchSize: config.indexing.embeddingBatchSize,
        embeddingConcurrency: config.indexing.embeddingConcurrency,
      })
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
      this.stop()
      await new Promise<void>(r => setTimeout(r, 100))
    }
    this.indexing = true
    this.abortController = new AbortController()

    if (this.vector) {
      try {
        await this.vector.init()
        this.forceVectorBackfill = await this.vector.isEmpty()
        await this.vector.markIndexingIncomplete()
      } catch (err) {
        console.warn("[nexus] Vector index init failed:", err)
        this.vector = undefined
        this.forceVectorBackfill = false
      }
    } else {
      this.forceVectorBackfill = false
    }

    this.notifyStatus({ state: "indexing", progress: 0, total: 0, chunksProcessed: 0, chunksTotal: 0 })
    await this.fileTracker.load()

    this.indexInBackground().catch(err => {
      console.warn("[nexus] Indexing error:", err)
      this.notifyStatus({ state: "error", error: (err as Error).message })
      this.indexing = false
    })
  }

  private async indexInBackground(): Promise<void> {
    const existing = this.fileTracker.getFilesWithHashes()
    const seen = new Set<string>()
    const discovered: FileInfo[] = []

    for await (const file of walkDir(this.projectRoot, this.config.indexing.excludePatterns)) {
      if (this.abortController?.signal.aborted) break
      seen.add(file.path)
      discovered.push(file)
    }

    if (this.abortController?.signal.aborted) {
      this.indexing = false
      return
    }

    const hasExistingData = this.vector ? await this.vector.hasIndexedData() : false
    const incrementalMode = Boolean(hasExistingData && !this.forceVectorBackfill)

    this.notifyStatus({ state: "indexing", progress: 0, total: discovered.length, chunksProcessed: 0, chunksTotal: 0 })
    const preparedAll: PreparedFile[] = []
    let chunksTotal = 0
    const parseLimit = pLimit(PARSE_CONCURRENCY)

    for (let i = 0; i < discovered.length; i += PARSE_CONCURRENCY) {
      if (this.abortController?.signal.aborted) break
      const chunk = discovered.slice(i, i + PARSE_CONCURRENCY)
      const results = await Promise.all(
        chunk.map((file) =>
          parseLimit(async () => {
            if (this.abortController?.signal.aborted) return null
            const unchanged = this.fileTracker.isFileIndexed(file.path, file.mtime, file.hash)
            const shouldUpdateVector = unchanged ? this.forceVectorBackfill : true
            if (incrementalMode && unchanged) return null
            const content = await fs.readFile(file.absPath, "utf8").catch(() => null)
            if (content == null) return null
            const extracted = this.extractEntries(file, content)
            return { file, unchanged, shouldUpdateVector, extracted } as PreparedFile
          })
        )
      )
      for (const r of results) {
        if (r) {
          preparedAll.push(r)
          chunksTotal += r.extracted.length
        }
      }
    }

    const toIndex = preparedAll.filter((p) => p.shouldUpdateVector)
    const totalFilesToIndex = toIndex.length
    const batchSize = Math.max(1, this.config.indexing.batchSize ?? 50)
    let processedFiles = 0
    let chunksProcessed = 0
    this.notifyStatus({ state: "indexing", progress: 0, total: totalFilesToIndex, chunksProcessed, chunksTotal })

    if (this.abortController?.signal.aborted) {
      this.indexing = false
      return
    }

    for (let i = 0; i < toIndex.length; i += batchSize) {
      if (this.abortController?.signal.aborted) break
      const slice = toIndex.slice(i, i + batchSize)
      const onProgress = (delta: number) => {
        chunksProcessed += delta
        this.notifyStatus({ state: "indexing", progress: processedFiles, total: totalFilesToIndex, chunksProcessed, chunksTotal })
      }
      await this.processPreparedBatch(slice, onProgress)
      processedFiles += slice.length
      this.notifyStatus({ state: "indexing", progress: processedFiles, total: totalFilesToIndex, chunksProcessed, chunksTotal })
      await new Promise<void>(r => setImmediate(r))
    }

    if (this.abortController?.signal.aborted) {
      this.indexing = false
      return
    }

    for (const [filePath] of existing) {
      if (!seen.has(filePath)) {
        this.fileTracker.deleteFile(filePath)
        await this.vector?.deleteByPath(filePath)
      }
    }

    if (this.vector && this.config.indexing.vector) {
      await this.vector.markIndexingComplete()
    }

    await this.fileTracker.save()
    this.notifyStatus({ state: "ready", files: seen.size, symbols: chunksTotal, chunks: chunksTotal })
    this.forceVectorBackfill = false
    this.indexing = false
  }

  private extractEntries(file: FileInfo, content: string): SymbolEntry[] {
    const supportsStructuredSymbols = SUPPORTED_CODE_EXTENSIONS.has(file.ext) && this.config.indexing.symbolExtract
    const supportsMarkdownSections = SUPPORTED_MARKDOWN_EXTENSIONS.has(file.ext)
    return (supportsStructuredSymbols || supportsMarkdownSections)
      ? extractSymbols(content, file.path, file.ext)
      : extractChunks(content, file.path)
  }

  private async processPreparedBatch(
    files: PreparedFile[],
    onProgress?: (indexedCount: number) => void
  ): Promise<{ processedFiles: number }> {
    if (this.vector && this.config.indexing.vector) {
      const modifiedPaths: string[] = []
      for (const entry of files) {
        const { file, unchanged } = entry
        if (!unchanged && this.fileTracker.getChunks(file.path) != null) {
          modifiedPaths.push(file.path)
        }
      }
      if (modifiedPaths.length > 0) {
        await Promise.all(modifiedPaths.map((p) => this.vector!.deleteByPath(p)))
      }
    }

    const vectorEntries: Parameters<VectorIndex["upsertSymbols"]>[0] = []

    for (const entry of files) {
      const { file, extracted, unchanged, shouldUpdateVector } = entry

      if (!unchanged || this.fileTracker.getChunks(file.path) == null) {
        this.fileTracker.upsertFile(file.path, file.mtime, file.hash, extracted.length)
      }

      if (this.vector && this.config.indexing.vector && shouldUpdateVector) {
        for (const sym of extracted) {
          const id = `${file.hash}_${sym.startLine}_${sym.kind}_${sym.name}_${sym.parent ?? ""}`
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
    }

    if (vectorEntries.length > 0 && this.vector) {
      try {
        await this.vector.upsertSymbols(vectorEntries, onProgress)
      } catch (err) {
        if (err instanceof VectorAuthError) {
          this.vector = undefined
        } else {
          throw err
        }
      }
    }

    return { processedFiles: files.length }
  }

  private async processBatch(files: FileInfo[]): Promise<{ plannedChunks: number; indexedChunks: number }> {
    const vectorEntries: Parameters<VectorIndex["upsertSymbols"]>[0] = []
    let plannedChunks = 0
    let indexedChunks = 0

    for (const file of files) {
      if (!file) continue

      const unchanged = this.fileTracker.isFileIndexed(file.path, file.mtime, file.hash)
      if (unchanged && !this.forceVectorBackfill) continue

      let content: string
      try {
        content = await fs.readFile(file.absPath, "utf8")
      } catch {
        continue
      }

      const shouldUpdateVector = unchanged ? this.forceVectorBackfill : true
      const extracted = this.extractEntries(file, content)

      plannedChunks += extracted.length
      indexedChunks += extracted.length
      if (!unchanged || this.fileTracker.getChunks(file.path) == null) {
        this.fileTracker.upsertFile(file.path, file.mtime, file.hash, extracted.length)
      }

      if (this.vector && this.config.indexing.vector && shouldUpdateVector) {
        for (const sym of extracted) {
          const id = `${file.hash}_${sym.startLine}_${sym.kind}_${sym.name}_${sym.parent ?? ""}`
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
    }

    if (vectorEntries.length > 0 && this.vector) {
      try {
        await this.vector.upsertSymbols(vectorEntries)
      } catch (err) {
        if (err instanceof VectorAuthError) {
          this.vector = undefined
        } else {
          throw err
        }
      }
    }

    return { plannedChunks, indexedChunks }
  }

  async refreshFile(filePath: string): Promise<void> {
    const existing = this.debounceTimers.get(filePath)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(async () => {
      this.debounceTimers.delete(filePath)
      if (this.indexing) {
        this.refreshFile(filePath)
        return
      }
      try {
        await this.refreshFileNow(filePath)
      } catch {}
    }, this.config.indexing.debounceMs)
    this.debounceTimers.set(filePath, timer)
  }

  async refreshFileNow(filePath: string): Promise<void> {
    const fileInfo = await buildFileInfo(filePath, this.projectRoot)
    if (!fileInfo) {
      const relPath = path.relative(this.projectRoot, filePath)
      if (!relPath || relPath.startsWith("..")) return
      this.fileTracker.deleteFile(relPath)
      await this.vector?.deleteByPath(relPath)
      return
    }
    await this.fileTracker.load()
    // Delete existing vector points for this file before re-upserting (same as processPreparedBatch for modified files)
    if (this.vector && this.config.indexing.vector && this.fileTracker.getChunks(fileInfo.path) != null) {
      await this.vector.deleteByPath(fileInfo.path)
    }
    await this.processBatch([fileInfo])
    await this.fileTracker.save()
  }

  async search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]> {
    const limit = opts?.limit ?? 10
    const kind = opts?.kind
    const pathScope = opts?.pathScope
    const prefixes = pathScope
      ? (Array.isArray(pathScope) ? pathScope : [pathScope])
          .map((p) => p.replace(/\\/g, "/").replace(/\/+$/, ""))
          .filter(Boolean)
      : []

    const matchesPath = (p: string): boolean => {
      if (prefixes.length === 0) return true
      const normalized = p.replace(/\\/g, "/")
      return prefixes.some((pre) => normalized === pre || normalized.startsWith(`${pre}/`))
    }

    const results: IndexSearchResult[] = []

    if (this.vector && this.config.indexing.vector) {
      const vectorReady = await this.vector.hasIndexedData()
      if (vectorReady) {
        const requestLimit = prefixes.length > 0 ? limit * 3 : limit
        const pathScopeForVector = prefixes.length > 0 ? prefixes[0] : (Array.isArray(pathScope) ? pathScope[0] : pathScope)
        const vecResults = await this.vector.search(query, requestLimit, kind, pathScopeForVector)
        const vecFiltered = vecResults.filter((r) => matchesPath(r.path))
        results.push(...vecFiltered.slice(0, limit))
      }
    }

    return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit)
  }

  async reindex(): Promise<void> {
    this.stop()
    this.fileTracker.clear()
    await this.fileTracker.save()
    await this.vector?.clearCollection()
    await this.startIndexing()
  }

  /** Clear index (vector + file tracker) without reindexing. */
  async deleteIndex(): Promise<void> {
    this.stop()
    this.fileTracker.clear()
    await this.fileTracker.save()
    await this.vector?.clearCollection()
    this.notifyStatus({ state: "idle" })
  }

  stop(): void {
    this.abortController?.abort()
    this.indexing = false
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
  }

  close(): void {
    this.stop()
    this.statusListeners = []
  }
}

async function buildFileInfo(absPath: string, root: string): Promise<FileInfo | null> {
  try {
    const s = await fs.stat(absPath)
    if (!s.isFile()) return null
    if (s.size > 1024 * 1024) return null
    const relPath = path.relative(root, absPath)
    if (!relPath || relPath.startsWith("..")) return null
    const ext = path.extname(absPath).toLowerCase()
    if (!SUPPORTED_INDEX_EXTENSIONS.has(ext)) return null
    const content = await fs.readFile(absPath)
    const hash = crypto.createHash("md5").update(content).digest("hex")
    return {
      path: relPath,
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
