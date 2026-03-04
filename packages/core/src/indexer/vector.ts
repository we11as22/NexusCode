import { QdrantClient } from "@qdrant/js-client-rest"
import type { IndexSearchResult, SymbolKind } from "../types.js"
import type { EmbeddingClient } from "../provider/types.js"
import crypto from "node:crypto"

/** Thrown when vector upsert fails due to missing/invalid embeddings API key; indexer should disable vector for this run. */
export class VectorAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VectorAuthError"
  }
}

/** Deterministic point id for indexing metadata (indexing_complete marker). */
function getIndexingMetadataPointId(): string {
  const hex = crypto.createHash("md5").update("__nexus_indexing_metadata__").digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Build pathSegments payload for Qdrant filter (indexed by pathSegments.0 .. pathSegments.4). */
function pathToSegments(filePath: string): Record<string, string> {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "")
  const segments = normalized.split("/").filter(Boolean)
  const out: Record<string, string> = {}
  for (let i = 0; i < Math.min(segments.length, 5); i++) {
    out[String(i)] = segments[i]!
  }
  return out
}

const MAX_BATCH_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 500

/**
 * Qdrant vector store for semantic code search.
 * One collection per project, named nexus_{project_hash}.
 * Uses pathSegments in payload for server-side path filtering (Roo-Code style).
 */
export class VectorIndex {
  private client: QdrantClient
  private collectionName: string
  private embeddings: EmbeddingClient
  private initialized = false
  private vectorSize: number
  private embeddingBatchSize: number
  private embeddingConcurrency: number
  readonly dimensions: number
  private authErrorLogged = false

  constructor(
    url: string,
    projectHash: string,
    embeddings: EmbeddingClient,
    opts?: {
      embeddingBatchSize?: number
      embeddingConcurrency?: number
    }
  ) {
    this.client = new QdrantClient({ url, checkCompatibility: false })
    this.collectionName = `nexus_${projectHash}`
    this.embeddings = embeddings
    this.dimensions = embeddings.dimensions
    this.vectorSize = embeddings.dimensions
    this.embeddingBatchSize = Math.max(1, opts?.embeddingBatchSize ?? 60)
    this.embeddingConcurrency = Math.max(1, opts?.embeddingConcurrency ?? 2)
  }

  async init(): Promise<void> {
    try {
      const resolvedSize = await this.resolveVectorSize()
      this.vectorSize = resolvedSize

      // Create collection if it doesn't exist
      const collections = await this.client.getCollections()
      let exists = collections.collections.some(c => c.name === this.collectionName)

      // Existing collection might be created with a wrong vector size from old config/defaults.
      if (exists) {
        const existingSize = await this.getExistingVectorSize().catch(() => null)
        if (existingSize && existingSize !== resolvedSize) {
          await this.client.deleteCollection(this.collectionName)
          exists = false
        }
      }

      if (!exists) {
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: resolvedSize,
            distance: "Cosine",
            on_disk: true,
          },
          hnsw_config: {
            m: 64,
            ef_construct: 512,
            on_disk: true,
          },
        } as Record<string, unknown>)
      }

      await this.ensurePayloadIndexes()
      this.initialized = true
    } catch (err) {
      throw new Error(`Failed to initialize Qdrant collection: ${(err as Error).message}`)
    }
  }

  private async resolveVectorSize(): Promise<number> {
    const configured = Number.isFinite(this.dimensions) && this.dimensions > 0
      ? this.dimensions
      : 0

    try {
      const vectors = await this.embeddings.embed(["nexus vector dimension probe"])
      const observed = vectors[0]?.length ?? 0
      if (observed > 0) {
        return observed
      }
    } catch {
      // Fall back to configured size when probe is unavailable.
    }

    if (configured > 0) {
      return configured
    }

    throw new Error("Unable to resolve embedding vector size. Set embeddings.dimensions explicitly.")
  }

  private async getExistingVectorSize(): Promise<number | null> {
    const info = await this.client.getCollection(this.collectionName) as Record<string, unknown>
    const result = info["result"] as Record<string, unknown> | undefined
    const config = result?.["config"] as Record<string, unknown> | undefined
    const params = config?.["params"] as Record<string, unknown> | undefined
    const vectors = params?.["vectors"] as Record<string, unknown> | undefined
    const size = vectors?.["size"]
    return typeof size === "number" && Number.isFinite(size) ? size : null
  }

  /** Create payload indexes for pathSegments (server-side path filter) and type (metadata). */
  private async ensurePayloadIndexes(): Promise<void> {
    try {
      await this.client.createPayloadIndex(this.collectionName, {
        field_name: "type",
        field_schema: "keyword",
      })
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? ""
      if (!msg.toLowerCase().includes("already exists")) {
        console.warn("[nexus] Vector payload index type:", (e as Error)?.message)
      }
    }
    for (let i = 0; i <= 4; i++) {
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: `pathSegments.${i}`,
          field_schema: "keyword",
        })
      } catch (e: unknown) {
        const msg = (e as Error)?.message ?? ""
        if (!msg.toLowerCase().includes("already exists")) {
          console.warn(`[nexus] Vector payload index pathSegments.${i}:`, (e as Error)?.message)
        }
      }
    }
  }

  async upsertSymbols(symbols: Array<{
    id: string
    path: string
    name: string
    kind?: SymbolKind
    parent?: string
    startLine?: number
    content: string
  }>, onProgress?: (indexedCount: number) => void): Promise<void> {
    if (!this.initialized || symbols.length === 0) return

    try {
      const batches = chunk(symbols, this.embeddingBatchSize)

      for (let i = 0; i < batches.length; i += this.embeddingConcurrency) {
        const group = batches.slice(i, i + this.embeddingConcurrency)
        let lastErr: Error | null = null
        for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
          try {
            await Promise.all(group.map(batch => this.upsertBatch(batch)))
            const count = group.reduce((s, b) => s + b.length, 0)
            if (onProgress && count > 0) onProgress(count)
            lastErr = null
            break
          } catch (err) {
            lastErr = err instanceof Error ? err : new Error(String(err))
            if (attempt < MAX_BATCH_RETRIES) {
              const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1)
              await new Promise(r => setTimeout(r, delay))
            } else {
              throw lastErr
            }
          }
        }
        if (lastErr) throw lastErr
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const isAuthError = /auth|api.?key|401|403|missing.*header/i.test(message)
      if (isAuthError) {
        if (!this.authErrorLogged) {
          this.authErrorLogged = true
          if (process.env["NEXUS_DEBUG"]) {
            console.warn(`[nexus] Vector upsert failed (embeddings API key missing/invalid): ${message}`)
            console.warn(`[nexus] Disabling vector index for this run.`)
          }
        }
        throw new VectorAuthError(message)
      }
      console.warn(`[nexus] Vector upsert failed: ${message}`)
    }
  }

  private async upsertBatch(symbols: Array<{
    id: string
    path: string
    name: string
    kind?: SymbolKind
    parent?: string
    startLine?: number
    content: string
  }>): Promise<void> {
    if (symbols.length === 0) return

    const texts = symbols.map(s =>
      [s.name, s.kind ?? "", s.parent ?? "", s.content.slice(0, 500)].filter(Boolean).join(" ")
    )
    const vectors = await this.embeddings.embed(texts)
    if (vectors.length === 0) return

    const observedSize = vectors[0]?.length ?? 0
    if (observedSize > 0 && observedSize !== this.vectorSize) {
      await this.recreateCollection(observedSize)
    }

    const points = symbols.map((s, i) => {
      const pathSegments = pathToSegments(s.path)
      return {
        id: toPointId(s.id),
        vector: vectors[i]!,
        payload: {
          path: s.path,
          pathSegments,
          name: s.name,
          kind: s.kind ?? "chunk",
          parent: s.parent ?? null,
          startLine: s.startLine ?? 0,
          content: s.content.slice(0, 1000),
        },
      }
    }).filter(p => Array.isArray(p.vector) && p.vector.length === this.vectorSize)

    if (points.length === 0) return

    try {
      await this.client.upsert(this.collectionName, { points })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const sizeHint = detectSizeFromMessage(message)
      if (sizeHint && sizeHint !== this.vectorSize) {
        await this.recreateCollection(sizeHint)
        await this.client.upsert(this.collectionName, { points })
        return
      }
      if (/bad request/i.test(message)) {
        const fallbackSize = observedSize > 0 ? observedSize : this.vectorSize
        await this.recreateCollection(fallbackSize)
        await this.client.upsert(this.collectionName, { points })
        return
      }
      throw err
    }
  }

  async deleteByPath(filePath: string): Promise<void> {
    if (!this.initialized) return
    try {
      const segments = pathToSegments(filePath)
      const keys = Object.keys(segments)
      if (keys.length === 0) {
        await this.client.delete(this.collectionName, {
          filter: { must: [{ key: "path", match: { value: filePath } }] },
        })
        return
      }
      const must = keys.map(i => ({
        key: `pathSegments.${i}`,
        match: { value: segments[i]! },
      }))
      await this.client.delete(this.collectionName, { filter: { must } })
    } catch {}
  }

  async search(
    query: string,
    limit: number,
    kind?: SymbolKind,
    pathScope?: string | string[]
  ): Promise<IndexSearchResult[]> {
    if (!this.initialized) return []

    try {
      const [vector] = await this.embeddings.embed([query])
      if (!vector) return []

      const must: Array<{ key: string; match: { value: string } }> = []
      if (kind) {
        must.push({ key: "kind", match: { value: kind } })
      }

      const prefix = Array.isArray(pathScope) ? pathScope[0] : pathScope
      if (prefix && prefix.trim()) {
        const normalized = prefix.replace(/\\/g, "/").replace(/^\.\/|\/+$/g, "").trim()
        if (normalized && normalized !== ".") {
          const segments = normalized.split("/").filter(Boolean)
          for (let i = 0; i < segments.length; i++) {
            must.push({ key: `pathSegments.${i}`, match: { value: segments[i]! } })
          }
        }
      }

      const filter: { must?: Array<{ key: string; match: { value: string } }>; must_not?: Array<{ key: string; match: { value: string } }> } =
        must.length > 0 ? { must } : {}
      filter.must_not = [{ key: "type", match: { value: "metadata" } }]

      const results = await this.client.search(this.collectionName, {
        vector,
        limit,
        filter,
        with_payload: true,
      })

      return results.map(r => ({
        path: r.payload?.["path"] as string ?? "",
        name: r.payload?.["name"] as string | undefined,
        kind: r.payload?.["kind"] as SymbolKind | undefined,
        parent: r.payload?.["parent"] as string | undefined,
        startLine: r.payload?.["startLine"] as number | undefined,
        content: r.payload?.["content"] as string ?? "",
        score: r.score,
      }))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[nexus] Vector search failed: ${message}`)
      return []
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.getCollections()
      return true
    } catch {
      return false
    }
  }

  async isEmpty(): Promise<boolean> {
    if (!this.initialized) return true
    try {
      const info = await this.client.getCollection(this.collectionName) as Record<string, unknown>
      const result = info["result"] as Record<string, unknown> | undefined
      const pointsCount = result?.["points_count"]
      return typeof pointsCount !== "number" || pointsCount <= 0
    } catch {
      return true
    }
  }

  /**
   * True if collection has data and indexing has been marked complete (Roo-Code style).
   * Used to avoid treating in-progress or stale index as ready.
   */
  async hasIndexedData(): Promise<boolean> {
    if (!this.initialized) return false
    try {
      const info = await this.client.getCollection(this.collectionName) as Record<string, unknown>
      const result = info["result"] as Record<string, unknown> | undefined
      const pointsCount = result?.["points_count"]
      if (typeof pointsCount !== "number" || pointsCount <= 0) return false

      const metaId = getIndexingMetadataPointId()
      const points = await this.client.retrieve(this.collectionName, { ids: [metaId] })
      if (points.length > 0 && points[0]?.payload?.indexing_complete === true) {
        return true
      }
      return pointsCount > 0
    } catch {
      return false
    }
  }

  async markIndexingIncomplete(): Promise<void> {
    if (!this.initialized) return
    try {
      const metaId = getIndexingMetadataPointId()
      await this.client.upsert(this.collectionName, {
        points: [{
          id: metaId,
          vector: new Array(this.vectorSize).fill(0),
          payload: { type: "metadata", indexing_complete: false, started_at: Date.now() },
        }],
      })
    } catch (e) {
      if (process.env["NEXUS_DEBUG"]) {
        console.warn("[nexus] markIndexingIncomplete failed:", (e as Error)?.message)
      }
    }
  }

  async markIndexingComplete(): Promise<void> {
    if (!this.initialized) return
    try {
      const metaId = getIndexingMetadataPointId()
      await this.client.upsert(this.collectionName, {
        points: [{
          id: metaId,
          vector: new Array(this.vectorSize).fill(0),
          payload: { type: "metadata", indexing_complete: true, completed_at: Date.now() },
        }],
      })
    } catch (e) {
      console.warn("[nexus] markIndexingComplete failed:", (e as Error)?.message)
    }
  }

  async clearCollection(): Promise<void> {
    try {
      await this.client.deleteCollection(this.collectionName)
    } catch {
      // No-op if collection does not exist or cannot be removed now.
    } finally {
      this.initialized = false
    }
  }

  private async recreateCollection(size: number): Promise<void> {
    if (!Number.isFinite(size) || size <= 0) return
    try {
      await this.client.deleteCollection(this.collectionName)
    } catch {
      // collection may not exist yet
    }
    await this.client.createCollection(this.collectionName, {
      vectors: {
        size,
        distance: "Cosine",
        on_disk: true,
      },
      hnsw_config: {
        m: 64,
        ef_construct: 512,
        on_disk: true,
      },
    } as Record<string, unknown>)
    this.vectorSize = size
    this.initialized = true
  }
}

function toPointId(value: string): string {
  const hex = crypto.createHash("md5").update(value).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

function detectSizeFromMessage(message: string): number | null {
  // Qdrant mismatch errors usually contain "... expected 1024 ... got 1536 ..."
  const expected = message.match(/expected[^0-9]*(\d{2,5})/i)
  if (expected?.[1]) {
    const n = Number(expected[1])
    if (Number.isFinite(n) && n > 0) return n
  }
  const vectorSize = message.match(/vector[^0-9]*(\d{2,5})/i)
  if (vectorSize?.[1]) {
    const n = Number(vectorSize[1])
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}
