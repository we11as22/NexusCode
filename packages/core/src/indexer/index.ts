import * as path from "node:path"
import * as fs from "node:fs/promises"
import { mkdirSync } from "node:fs"
import pLimit from "p-limit"
import type { IIndexer, IndexStatus, IndexSearchOptions, IndexSearchResult, NexusConfig, SymbolEntry } from "../types.js"
import type { FileInfo } from "./scanner.js"
import {
  buildIndexFileInfo,
  collectIndexFiles,
  createIndexerIgnore,
  getIndexableExtensions,
  materializeIndexFileInfos,
} from "./scanner.js"
import { INDEX_MAX_LIST_FILES_ROO, INDEX_PARSING_CONCURRENCY } from "./indexing-capacity.js"
import type { CodebaseIndexerHostOptions } from "./host-types.js"
import { captureIndexTelemetry } from "./index-telemetry.js"
import { FileTracker } from "./file-tracker.js"
import { VectorIndex, VectorAuthError } from "./vector.js"
import { extractSymbols, extractChunks } from "./ast-extractor.js"
import { rooCodeParser, rooBlocksToSymbolEntries } from "./roo/index.js"
import { getIndexDir } from "./multi-project.js"
import type { EmbeddingClient } from "../provider/types.js"

const SUPPORTED_CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rs", ".go", ".java", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
])
const SUPPORTED_MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"])

interface PreparedFile {
  file: FileInfo
  unchanged: boolean
  shouldUpdateVector: boolean
  extracted: SymbolEntry[]
}

interface QueuedSymbol {
  file: FileInfo
  unchanged: boolean
  shouldUpdateVector: boolean
  sym: SymbolEntry
}

/** Roo `CodeIndexStateManager.reportBlockIndexingProgress`: percent = indexed / max(found, indexed). */
function blockPrimaryIndexPercent(
  vectorOn: boolean,
  filesParsed: number,
  filesTotal: number,
  chunksIndexed: number,
  chunksFoundSoFar: number,
): number {
  if (filesTotal <= 0) return 0
  if (!vectorOn) {
    return Math.min(100, Math.round((filesParsed / filesTotal) * 100))
  }
  const denom = Math.max(chunksFoundSoFar, chunksIndexed, 1)
  return Math.min(100, Math.round((chunksIndexed / denom) * 100))
}

/** Roo-style primary line: block counts; files as secondary context. */
function blockPrimaryIndexMessage(
  vectorOn: boolean,
  filesParsed: number,
  filesTotal: number,
  chunksIndexed: number,
  chunksFoundSoFar: number,
): string {
  if (filesTotal <= 0) return "No files to index"
  const filesPart = `Files ${filesParsed.toLocaleString()} / ${filesTotal.toLocaleString()}`
  if (!vectorOn) return filesPart
  const denom = Math.max(chunksFoundSoFar, chunksIndexed)
  return `Indexed ${chunksIndexed.toLocaleString()} / ${denom.toLocaleString()} chunks found · ${filesPart}`
}

export class CodebaseIndexer implements IIndexer {
  private fileTracker: FileTracker
  private vector?: VectorIndex
  private forceVectorBackfill = false
  private _status: IndexStatus = { state: "idle" }
  private indexing = false
  private abortController?: AbortController
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private statusListeners: Array<(status: IndexStatus) => void> = []
  private indexingPaused = false
  private pauseWaiters: Array<() => void> = []
  private readonly hostListAbsolutePaths?: CodebaseIndexerHostOptions["listAbsolutePaths"]

  constructor(
    private readonly projectRoot: string,
    private readonly config: NexusConfig,
    embeddingClient?: EmbeddingClient,
    vectorUrl?: string,
    projectHash?: string,
    hostOptions?: CodebaseIndexerHostOptions,
  ) {
    const indexDir = getIndexDir(projectRoot)
    mkdirSync(indexDir, { recursive: true })
    this.fileTracker = new FileTracker(indexDir, hostOptions?.fileTrackerJsonPath)
    this.hostListAbsolutePaths = hostOptions?.listAbsolutePaths

    if (config.vectorDb?.enabled && embeddingClient && vectorUrl && projectHash) {
      this.vector = new VectorIndex(vectorUrl, projectHash, embeddingClient, {
        embeddingBatchSize: config.indexing.embeddingBatchSize,
        embeddingConcurrency: config.indexing.embeddingConcurrency,
        qdrantApiKey: config.vectorDb.apiKey || undefined,
        upsertWait: config.vectorDb.upsertWait ?? true,
        searchMinScore: config.vectorDb.searchMinScore,
        searchHnswEf: config.vectorDb.searchHnswEf ?? 128,
        searchExact: config.vectorDb.searchExact ?? false,
      })
    }
  }

  status(): IndexStatus {
    return this._status
  }

  /** False when config requests vector search but factory fell back (no Qdrant, missing embed key, etc.). */
  semanticSearchActive(): boolean {
    return Boolean(this.vector && this.config.indexing.vector && this.config.vectorDb?.enabled)
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
      try {
        listener(status)
      } catch {
        /* */
      }
    }
  }

  private flushPauseWaiters(): void {
    const w = this.pauseWaiters.splice(0)
    for (const fn of w) {
      try {
        fn()
      } catch {
        /* */
      }
    }
  }

  private async waitIfPaused(): Promise<void> {
    while (this.indexingPaused && this.indexing && !this.abortController?.signal.aborted) {
      await new Promise<void>(resolve => this.pauseWaiters.push(resolve))
    }
  }

  /** Pause between parse/embed checkpoints (does not cancel in-flight embedding API calls). */
  pauseIndexing(): void {
    if (!this.indexing || this.indexingPaused || this._status.state === "stopping") return
    this.indexingPaused = true
    if (this._status.state === "indexing") {
      const s = this._status as Extract<IndexStatus, { state: "indexing" }>
      this.notifyStatus({ ...s, paused: true })
    }
  }

  resumeIndexing(): void {
    if (!this.indexingPaused) return
    this.indexingPaused = false
    this.flushPauseWaiters()
    if (this._status.state === "indexing") {
      const s = this._status as Extract<IndexStatus, { state: "indexing" }>
      this.notifyStatus({ ...s, paused: false })
    }
  }

  async startIndexing(): Promise<void> {
    if (this.indexing) {
      this.stop()
      await new Promise<void>(r => setTimeout(r, 100))
    }
    this.indexingPaused = false
    this.flushPauseWaiters()
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

    this.notifyStatus({
      state: "indexing",
      progress: 0,
      total: 0,
      chunksProcessed: 0,
      chunksTotal: 0,
      overallPercent: 0,
      phase: "parsing",
      message: "Preparing file list…",
      paused: false,
    })
    await this.fileTracker.load()

    this.indexInBackground().catch(err => {
      console.warn("[nexus] Indexing error:", err)
      this.notifyStatus({ state: "error", error: (err as Error).message })
      this.indexing = false
    })
  }

  private async fatalResetAfterIndexingStarted(msg: string): Promise<void> {
    captureIndexTelemetry("index_fatal_reset", { message: msg })
    try {
      await this.vector?.clearCollection()
    } catch {
      /* */
    }
    this.vector = undefined
    this.fileTracker.clear()
    await this.fileTracker.save().catch(() => {})
    this.notifyStatus({ state: "error", error: msg })
    this.indexing = false
  }

  private async indexInBackground(): Promise<void> {
    const vectorOn = Boolean(this.vector && this.config.indexing.vector)
    const maxFiles = this.config.indexing.maxIndexedFiles ?? 0

    await this.fileTracker.load()

    /** Roo `listFiles(..., 0)` — no scan. */
    if (maxFiles <= 0) {
      captureIndexTelemetry("index_scan_disabled", { maxIndexedFiles: maxFiles })
      this.notifyStatus({
        state: "ready",
        files: 0,
        symbols: 0,
        chunks: 0,
      })
      this.indexing = false
      return
    }

    const signal = this.abortController!.signal
    let discovered: FileInfo[]
    let truncated: boolean

    if (this.hostListAbsolutePaths) {
      try {
        const { paths, limitReached } = await this.hostListAbsolutePaths(this.projectRoot, maxFiles, signal)
        discovered = await materializeIndexFileInfos(
          this.projectRoot,
          paths,
          this.config.indexing.excludePatterns,
          Boolean(this.config.indexing.vector),
        )
        truncated = limitReached
      } catch (err) {
        captureIndexTelemetry("index_rg_list_fallback", { message: String(err) })
        const r = await collectIndexFiles(this.projectRoot, this.config.indexing.excludePatterns, {
          vectorIndexing: Boolean(this.config.indexing.vector),
          maxFiles,
        })
        discovered = r.files
        truncated = r.truncated
      }
    } else {
      const r = await collectIndexFiles(this.projectRoot, this.config.indexing.excludePatterns, {
        vectorIndexing: Boolean(this.config.indexing.vector),
        maxFiles,
      })
      discovered = r.files
      truncated = r.truncated
    }

    if (this.abortController?.signal.aborted) {
      this.indexing = false
      this.notifyStatus({ state: "idle" })
      return
    }

    if (truncated) {
      captureIndexTelemetry("index_limit_reached", { maxFiles })
      await this.fatalResetAfterIndexingStarted(
        `Indexing limit reached (${maxFiles} files; Roo default cap is ${INDEX_MAX_LIST_FILES_ROO.toLocaleString()}). Increase indexing.maxIndexedFiles in .nexus/nexus.yaml or narrow the workspace.`,
      )
      return
    }

    const seen = new Set(discovered.map(f => f.path))
    const existing = this.fileTracker.getFilesWithHashes()

    const hasExistingData = this.vector ? await this.vector.hasIndexedData() : false
    const incrementalMode = Boolean(hasExistingData && !this.forceVectorBackfill)

    const segmentThreshold = Math.max(1, this.config.indexing.embeddingBatchSize ?? 60)
    const maxPending = Math.max(1, this.config.indexing.maxPendingEmbedBatches ?? 20)
    const batchConc = Math.max(1, this.config.indexing.batchProcessingConcurrency ?? 10)
    const batchLimit = pLimit(batchConc)
    const failureRateMax = this.config.indexing.maxIndexingFailureRate ?? 0.1

    let filesParsed = 0
    let chunksFoundSoFar = 0
    let chunksIndexed = 0
    const batchErrors: Error[] = []

    const symbolQueue: QueuedSymbol[] = []
    const pendingChunkRemain = new Map<string, number>()
    const preparedByPath = new Map<string, PreparedFile>()
    const modifiedDeleteDone = new Set<string>()
    let pendingBatches = 0
    const activeBatchPromises = new Set<Promise<void>>()

    const emitProgress = (phase: "parsing" | "embedding") => {
      const filesTotal = discovered.length
      this.notifyStatus({
        state: "indexing",
        progress: filesParsed,
        total: filesTotal,
        chunksProcessed: chunksIndexed,
        chunksTotal: Math.max(chunksFoundSoFar, chunksIndexed),
        overallPercent: blockPrimaryIndexPercent(
          vectorOn,
          filesParsed,
          filesTotal,
          chunksIndexed,
          chunksFoundSoFar,
        ),
        phase,
        message: blockPrimaryIndexMessage(vectorOn, filesParsed, filesTotal, chunksIndexed, chunksFoundSoFar),
        paused: this.indexingPaused,
        watcherQueue: false,
      })
    }

    const runEmbedBatch = async (batch: QueuedSymbol[]): Promise<void> => {
      if (batch.length === 0 || !this.vector || !this.config.indexing.vector) return
      await this.waitIfPaused()

      const pathsInBatch = new Set(batch.map(b => b.file.path))
      const toDelete: string[] = []
      for (const p of pathsInBatch) {
        const first = batch.find(b => b.file.path === p)!
        if (!first.unchanged && this.fileTracker.getChunks(p) != null && !modifiedDeleteDone.has(p)) {
          toDelete.push(p)
          modifiedDeleteDone.add(p)
        }
      }
      if (toDelete.length > 0) {
        await Promise.all(toDelete.map(d => this.vector!.deleteByPath(d)))
      }

      const vectorEntries: Parameters<VectorIndex["upsertSymbols"]>[0] = []
      for (const q of batch) {
        if (!q.shouldUpdateVector) continue
        const { file, sym } = q
        const id = sym.segmentHash
          ? `${file.contentSha256}_${sym.segmentHash}`
          : `${file.contentSha256}_${sym.startLine}_${sym.kind}_${sym.name}_${sym.parent ?? ""}`
        vectorEntries.push({
          id,
          path: file.path,
          name: sym.name,
          kind: sym.kind,
          parent: sym.parent,
          startLine: sym.startLine,
          endLine: sym.endLine,
          content: sym.content,
        })
      }

      if (vectorEntries.length === 0) return

      await this.vector.upsertSymbols(vectorEntries, (delta) => {
        chunksIndexed += delta
        emitProgress("embedding")
      })

      const counted = new Map<string, number>()
      for (const q of batch) {
        if (!q.shouldUpdateVector) continue
        counted.set(q.file.path, (counted.get(q.file.path) ?? 0) + 1)
      }
      for (const [fp, n] of counted) {
        const left = (pendingChunkRemain.get(fp) ?? 0) - n
        if (left <= 0) {
          pendingChunkRemain.delete(fp)
          const pf = preparedByPath.get(fp)
          const total = pf?.extracted.length ?? n
          this.fileTracker.upsertFile(fp, pf?.file.contentSha256 ?? batch.find(b => b.file.path === fp)!.file.contentSha256, total)
          preparedByPath.delete(fp)
        } else {
          pendingChunkRemain.set(fp, left)
        }
      }
    }

    const flushQueueSlice = async (slice: QueuedSymbol[]): Promise<void> => {
      try {
        await runEmbedBatch(slice)
      } catch (e) {
        batchErrors.push(e instanceof Error ? e : new Error(String(e)))
      }
    }

    const tryFlushQueue = async (): Promise<void> => {
      while (symbolQueue.length >= segmentThreshold) {
        await this.waitIfPaused()
        while (pendingBatches >= maxPending) {
          await Promise.race([...activeBatchPromises])
        }
        const slice = symbolQueue.splice(0, segmentThreshold)
        pendingBatches++
        const p = batchLimit(() => flushQueueSlice(slice))
          .finally(() => {
            pendingBatches--
            activeBatchPromises.delete(p)
          })
        activeBatchPromises.add(p)
      }
    }

    const enqueuePreparedForVector = async (pf: PreparedFile): Promise<void> => {
      await this.waitIfPaused()
      preparedByPath.set(pf.file.path, pf)
      pendingChunkRemain.set(pf.file.path, pf.extracted.length)
      for (const sym of pf.extracted) {
        symbolQueue.push({
          file: pf.file,
          unchanged: pf.unchanged,
          shouldUpdateVector: pf.shouldUpdateVector,
          sym,
        })
      }
      await tryFlushQueue()
    }

    const parseLimit = pLimit(INDEX_PARSING_CONCURRENCY)

    emitProgress("parsing")

    type ParseSlot = { idx: number; result: PreparedFile | null }
    const parseSlots = await Promise.all(
      discovered.map((file, idx) =>
        parseLimit(async (): Promise<ParseSlot> => {
          if (this.abortController?.signal.aborted) return { idx, result: null }
          await this.waitIfPaused()
          if (this.abortController?.signal.aborted) return { idx, result: null }
          const unchanged = this.fileTracker.isFileIndexed(file.path, file.contentSha256)
          const shouldUpdateVector = unchanged ? this.forceVectorBackfill : true
          if (incrementalMode && unchanged && !this.forceVectorBackfill) return { idx, result: null }

          const content = await fs.readFile(file.absPath, "utf8").catch(() => null)
          if (content == null) return { idx, result: null }
          const extracted = await this.extractEntriesForIndex(file, content)
          return { idx, result: { file, unchanged, shouldUpdateVector, extracted } }
        }),
      ),
    )
    parseSlots.sort((a, b) => a.idx - b.idx)

    for (const { result: r } of parseSlots) {
      await this.waitIfPaused()
      if (this.abortController?.signal.aborted) break
      filesParsed++
      if (!r) continue
      chunksFoundSoFar += r.extracted.length
      emitProgress(vectorOn && r.shouldUpdateVector && r.extracted.length > 0 ? "embedding" : "parsing")

      if (!vectorOn) {
        if (r.shouldUpdateVector) {
          this.fileTracker.upsertFile(r.file.path, r.file.contentSha256, r.extracted.length)
        }
        continue
      }

      if (r.shouldUpdateVector && r.extracted.length > 0) {
        await enqueuePreparedForVector(r)
      } else if (r.shouldUpdateVector && r.extracted.length === 0) {
        this.fileTracker.upsertFile(r.file.path, r.file.contentSha256, 0)
      }
    }

    if (!this.abortController?.signal.aborted) {
      emitProgress("embedding")
    }

    if (this.abortController?.signal.aborted) {
      this.indexing = false
      this.notifyStatus({ state: "idle" })
      return
    }

    if (vectorOn && symbolQueue.length > 0) {
      await this.waitIfPaused()
      while (pendingBatches >= maxPending) {
        await Promise.race([...activeBatchPromises])
      }
      pendingBatches++
      const slice = symbolQueue.splice(0, symbolQueue.length)
      const p = batchLimit(() => flushQueueSlice(slice)).finally(() => {
        pendingBatches--
        activeBatchPromises.delete(p)
      })
      activeBatchPromises.add(p)
    }

    await this.waitIfPaused()
    await Promise.all([...activeBatchPromises])

    if (this.abortController?.signal.aborted) {
      this.indexing = false
      this.notifyStatus({ state: "idle" })
      return
    }

    await this.waitIfPaused()
    for (const [filePath] of existing) {
      if (!seen.has(filePath)) {
        this.fileTracker.deleteFile(filePath)
        await this.vector?.deleteByPath(filePath)
      }
    }

    const failureRate =
      chunksFoundSoFar > 0 ? (chunksFoundSoFar - chunksIndexed) / chunksFoundSoFar : 0
    const hadErrors = batchErrors.length > 0
    if (chunksFoundSoFar > 0 && chunksIndexed === 0 && hadErrors) {
      await this.fatalResetAfterIndexingStarted(
        `Indexing failed: ${batchErrors[0]?.message ?? "embed/upsert error"}`,
      )
      return
    }
    if (hadErrors && failureRate > failureRateMax) {
      await this.fatalResetAfterIndexingStarted(
        `Indexing partially failed (${batchErrors[0]?.message ?? "batch error"}). Failure rate exceeded indexing.maxIndexingFailureRate.`,
      )
      return
    }

    if (this.vector && this.config.indexing.vector) {
      await this.vector.markIndexingComplete()
    }

    await this.fileTracker.save()
    this.notifyStatus({
      state: "ready",
      files: seen.size,
      symbols: chunksFoundSoFar,
      chunks: chunksIndexed,
    })
    this.forceVectorBackfill = false
    this.indexing = false
  }

  private async extractEntriesForIndex(file: FileInfo, content: string): Promise<SymbolEntry[]> {
    if (this.config.indexing.vector) {
      const absPath = path.join(this.projectRoot, file.path)
      try {
        const blocks = await rooCodeParser.parseFile(absPath, { content, fileHash: file.contentSha256 })
        return rooBlocksToSymbolEntries(file.path, blocks)
      } catch (err) {
        console.warn("[nexus] Semantic chunk parse failed, using line chunks:", (err as Error).message)
        return extractChunks(content, file.path)
      }
    }
    return this.extractEntriesLegacy(file, content)
  }

  private extractEntriesLegacy(file: FileInfo, content: string): SymbolEntry[] {
    const supportsStructuredSymbols = SUPPORTED_CODE_EXTENSIONS.has(file.ext) && this.config.indexing.symbolExtract
    const supportsMarkdownSections = SUPPORTED_MARKDOWN_EXTENSIONS.has(file.ext)
    return supportsStructuredSymbols || supportsMarkdownSections
      ? extractSymbols(content, file.path, file.ext)
      : extractChunks(content, file.path)
  }

  private async processBatchLegacy(files: FileInfo[]): Promise<void> {
    const vectorEntries: Parameters<VectorIndex["upsertSymbols"]>[0] = []

    for (const file of files) {
      if (!file) continue
      const unchanged = this.fileTracker.isFileIndexed(file.path, file.contentSha256)
      if (unchanged && !this.forceVectorBackfill) continue

      let content: string
      try {
        content = await fs.readFile(file.absPath, "utf8")
      } catch {
        continue
      }

      const shouldUpdateVector = unchanged ? this.forceVectorBackfill : true
      const extracted = await this.extractEntriesForIndex(file, content)

      if (this.vector && this.config.indexing.vector && shouldUpdateVector) {
        if (!unchanged && this.fileTracker.getChunks(file.path) != null) {
          await this.vector.deleteByPath(file.path)
        }
        for (const sym of extracted) {
          const id = sym.segmentHash
            ? `${file.contentSha256}_${sym.segmentHash}`
            : `${file.contentSha256}_${sym.startLine}_${sym.kind}_${sym.name}_${sym.parent ?? ""}`
          vectorEntries.push({
            id,
            path: file.path,
            name: sym.name,
            kind: sym.kind,
            parent: sym.parent,
            startLine: sym.startLine,
            endLine: sym.endLine,
            content: sym.content,
          })
        }
      }

      if (!unchanged || this.fileTracker.getChunks(file.path) == null) {
        this.fileTracker.upsertFile(file.path, file.contentSha256, extracted.length)
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
      } catch {
        /* */
      }
    }, this.config.indexing.debounceMs)
    this.debounceTimers.set(filePath, timer)
  }

  async refreshFileNow(filePath: string): Promise<void> {
    await this.refreshFilesBatchNow([filePath])
  }

  async refreshFilesBatchNow(absPaths: string[]): Promise<void> {
    const unique = [...new Set(absPaths.map(p => path.resolve(p)))]
    if (unique.length === 0) return
    await this.fileTracker.load()
    if (this.indexing) {
      try {
        for (const abs of unique) {
          await this.refreshOneFileCore(abs)
        }
      } finally {
        await this.fileTracker.save()
      }
      return
    }

    const n = unique.length
    const ig = await createIndexerIgnore(this.projectRoot, this.config.indexing.excludePatterns)
    const toUpsert: FileInfo[] = []
    try {
      for (let i = 0; i < n; i++) {
        const abs = unique[i]!
        const base = path.basename(abs)
        this.notifyWatcherQueueProgress(i, n, base)
        const relPathRaw = path.relative(this.projectRoot, abs).replace(/\\/g, "/")
        if (!relPathRaw || relPathRaw.startsWith("..")) {
          this.notifyWatcherQueueProgress(i + 1, n, base)
          continue
        }
        if (ig.ignores(relPathRaw)) {
          this.fileTracker.deleteFile(relPathRaw)
          await this.vector?.deleteByPath(relPathRaw)
          this.notifyWatcherQueueProgress(i + 1, n, base)
          continue
        }
        const fileInfo = await buildIndexFileInfo(abs, this.projectRoot, Boolean(this.config.indexing.vector))
        if (!fileInfo) {
          this.fileTracker.deleteFile(relPathRaw)
          await this.vector?.deleteByPath(relPathRaw)
          this.notifyWatcherQueueProgress(i + 1, n, base)
          continue
        }
        toUpsert.push(fileInfo)
        this.notifyWatcherQueueProgress(i + 1, n, base)
      }
      /** Roo-style: one embed pass over the whole debounced batch (vector already chunks internally). */
      if (toUpsert.length > 0) {
        await this.processBatchLegacy(toUpsert)
      }
    } finally {
      await this.fileTracker.save()
    }
    const files = this.fileTracker.listPaths().length
    const chunks = this.fileTracker.totalChunkCount()
    this.notifyStatus({ state: "ready", files, symbols: chunks, chunks })
  }

  /** Roo `reportFileQueueProgress` — debounced watcher batch, not full scan. */
  private notifyWatcherQueueProgress(processed: number, total: number, currentBasename: string): void {
    const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0
    let msg: string
    if (total > 0 && processed < total) {
      msg = `Processing ${processed} / ${total} files from queue. Current: ${currentBasename}`
    } else if (total > 0 && processed === total) {
      msg = `Finished processing ${total} files from queue.`
    } else {
      msg = "File queue processed."
    }
    this.notifyStatus({
      state: "indexing",
      progress: processed,
      total,
      chunksProcessed: 0,
      chunksTotal: 0,
      overallPercent: pct,
      phase: "parsing",
      message: msg,
      watcherQueue: true,
      paused: false,
    })
  }

  private async refreshOneFileCore(absPath: string): Promise<void> {
    const relPathRaw = path.relative(this.projectRoot, absPath).replace(/\\/g, "/")
    if (!relPathRaw || relPathRaw.startsWith("..")) return

    const ig = await createIndexerIgnore(this.projectRoot, this.config.indexing.excludePatterns)
    if (ig.ignores(relPathRaw)) {
      this.fileTracker.deleteFile(relPathRaw)
      await this.vector?.deleteByPath(relPathRaw)
      return
    }

    const fileInfo = await buildIndexFileInfo(absPath, this.projectRoot, Boolean(this.config.indexing.vector))
    if (!fileInfo) {
      this.fileTracker.deleteFile(relPathRaw)
      await this.vector?.deleteByPath(relPathRaw)
      return
    }
    await this.processBatchLegacy([fileInfo])
  }

  async search(query: string, opts?: IndexSearchOptions): Promise<IndexSearchResult[]> {
    const limit = opts?.limit ?? 10
    const kind = opts?.kind
    const pathScope = opts?.pathScope
    const prefixes = pathScope
      ? (Array.isArray(pathScope) ? pathScope : [pathScope])
          .map(p => p.replace(/\\/g, "/").replace(/\/+$/, ""))
          .filter(Boolean)
      : []

    const matchesPath = (p: string): boolean => {
      if (prefixes.length === 0) return true
      const normalized = p.replace(/\\/g, "/")
      return prefixes.some(pre => normalized === pre || normalized.startsWith(`${pre}/`))
    }

    const results: IndexSearchResult[] = []

    if (this.vector && this.config.indexing.vector) {
      const st = this._status.state
      const allowPartial =
        st === "indexing" && this.config.indexing.searchWhileIndexing !== false
      const vectorReady = allowPartial
        ? await this.vector.hasSearchableCodePoints()
        : await this.vector.hasIndexedData()
      if (vectorReady) {
        const requestLimit = prefixes.length > 0 ? limit * 3 : limit
        const pathScopeForVector = prefixes.length > 0 ? prefixes[0] : (Array.isArray(pathScope) ? pathScope[0] : pathScope)
        const vecResults = await this.vector.search(query, requestLimit, kind, pathScopeForVector)
        const vecFiltered = vecResults.filter(r => matchesPath(r.path))
        results.push(...vecFiltered.slice(0, limit))
      }
    }

    return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit)
  }

  /**
   * Incremental sync / resume: one Qdrant collection + one tracker per project; does not wipe data.
   * Use `fullRebuildIndex` to clear and rebuild from scratch.
   */
  async syncIndexing(): Promise<void> {
    await this.startIndexing()
  }

  /** Full wipe + re-index (same collection name, empty contents). */
  async fullRebuildIndex(): Promise<void> {
    this.stop()
    this.fileTracker.clear()
    await this.fileTracker.save()
    await this.vector?.clearCollection()
    await this.startIndexing()
  }

  /** @deprecated use syncIndexing */
  async reindex(): Promise<void> {
    return this.syncIndexing()
  }

  async deleteIndex(): Promise<void> {
    this.stop()
    this.fileTracker.clear()
    await this.fileTracker.save()
    await this.vector?.clearCollection()
    this.notifyStatus({ state: "idle" })
  }

  /**
   * Remove tracker + vector points for a repo-relative prefix (folder or file path).
   * Does not delete other paths; one collection remains for the workspace.
   */
  async deleteIndexScope(relPathOrAbs: string): Promise<void> {
    let norm = relPathOrAbs.replace(/\\/g, "/").trim()
    if (path.isAbsolute(norm)) {
      norm = path.relative(this.projectRoot, norm).replace(/\\/g, "/")
    }
    norm = norm.replace(/^\/+|\/+$/g, "")
    if (norm.startsWith("..")) return
    if (!norm) {
      await this.deleteIndex()
      return
    }

    this.stop()
    await this.fileTracker.load()
    this.fileTracker.deleteFilesUnderPrefix(norm)
    await this.fileTracker.save()
    if (this.vector && this.config.indexing.vector) {
      try {
        await this.vector.init()
        await this.vector.deleteByPathPrefix(norm)
      } catch {
        /* */
      }
    }

    const remaining = this.fileTracker.listPaths().length
    if (remaining === 0) {
      await this.vector?.clearCollection()
      this.notifyStatus({ state: "idle" })
      return
    }
    const chunks = this.fileTracker.totalChunkCount()
    this.notifyStatus({
      state: "ready",
      files: remaining,
      symbols: chunks,
      chunks,
    })
  }

  stop(): void {
    if (this.indexing) {
      this.notifyStatus({ state: "stopping", message: "Stopping indexer…" })
    }
    this.indexingPaused = false
    this.flushPauseWaiters()
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

export { CodebaseIndexer as default }
