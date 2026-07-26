import type { IndexSearchResult, SymbolKind } from "../types.js"
import type { EmbeddingClient } from "../provider/types.js"
import type { QdrantClient as QdrantClientType } from "@qdrant/js-client-rest"
import crypto from "node:crypto"
import { createQdrantClient } from "./qdrant-client-factory.js"

/** Thrown when vector upsert fails due to missing/invalid embeddings API key; indexer should disable vector for this run. */
export class VectorAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VectorAuthError"
  }
}

class VectorBatchValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VectorBatchValidationError"
  }
}

/** Deterministic point id for indexing metadata (indexing_complete marker). */
function getIndexingMetadataPointId(): string {
  const hex = crypto.createHash("md5").update("__nexus_indexing_metadata__").digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const INDEX_SCHEMA_VERSION = 2

/** Every cumulative repo-relative prefix, allowing exact prefix filters at any depth. */
function pathToPrefixes(filePath: string): string[] {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "")
  const segments = normalized.split("/").filter(Boolean)
  const prefixes: string[] = []
  for (let i = 0; i < segments.length; i++) {
    prefixes.push(segments.slice(0, i + 1).join("/"))
  }
  return prefixes
}

/**
 * Qdrant REST returns `{ result: CollectionInfo }`. `@qdrant/js-client-rest` returns `CollectionInfo`
 * at the top level. Older code assumed `.result` only — then `points_count` was always missing and
 * `hasIndexedData()` stayed false while the UI showed "ready", so semantic search never ran.
 */
function qdrantCollectionBody(response: unknown): Record<string, unknown> | null {
  if (response == null || typeof response !== "object") return null
  const o = response as Record<string, unknown>
  const inner = o["result"]
  if (inner != null && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>
  }
  return o
}

function pointsFromQueryResponse(response: unknown): Array<Record<string, unknown>> {
  if (response == null || typeof response !== "object") return []
  const o = response as Record<string, unknown>
  const top = o["points"]
  if (Array.isArray(top)) return top as Array<Record<string, unknown>>
  const inner = o["result"]
  if (inner != null && typeof inner === "object") {
    const p = (inner as Record<string, unknown>)["points"]
    if (Array.isArray(p)) return p as Array<Record<string, unknown>>
  }
  return []
}

function pointsFromScrollResponse(response: unknown): Array<Record<string, unknown>> {
  if (response == null || typeof response !== "object") return []
  const o = response as Record<string, unknown>
  const top = o["points"]
  if (Array.isArray(top)) return top as Array<Record<string, unknown>>
  const inner = o["result"]
  if (inner != null && typeof inner === "object") {
    const p = (inner as Record<string, unknown>)["points"]
    if (Array.isArray(p)) return p as Array<Record<string, unknown>>
  }
  return []
}

function isNotFoundError(error: unknown): boolean {
  const candidate = error as {
    status?: unknown
    statusCode?: unknown
    response?: { status?: unknown }
    message?: unknown
  }
  const status = candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status
  if (status === 404) return true
  return typeof candidate?.message === "string" && /\bnot found\b|\b404\b/i.test(candidate.message)
}

const MAX_BATCH_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 500

/**
 * Qdrant vector store for semantic code search.
 * One collection per project, named nexus_{project_hash}.
 * Uses pathSegments in payload for server-side path filtering.
 */
export class VectorIndex {
  private client: QdrantClientType
  private collectionName: string
  private embeddings: EmbeddingClient
  private initialized = false
  private vectorSize: number
  private embeddingBatchSize: number
  private embeddingConcurrency: number
  readonly dimensions: number
  private authErrorLogged = false
  private readonly upsertWait: boolean
  private readonly searchMinScore?: number
  private readonly searchHnswEf: number
  private readonly searchExact: boolean

  constructor(
    url: string,
    projectHash: string,
    embeddings: EmbeddingClient,
    opts?: {
      embeddingBatchSize?: number
      embeddingConcurrency?: number
      qdrantApiKey?: string
      collectionPrefix?: string
      upsertWait?: boolean
      searchMinScore?: number
      searchHnswEf?: number
      searchExact?: boolean
    }
  ) {
    this.client = createQdrantClient(url, opts?.qdrantApiKey)
    const collectionPrefix = (opts?.collectionPrefix ?? "nexus")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "nexus"
    this.collectionName = `${collectionPrefix}_${projectHash}`
    this.embeddings = embeddings
    this.dimensions = embeddings.dimensions
    this.vectorSize = embeddings.dimensions
    this.embeddingBatchSize = Math.max(1, opts?.embeddingBatchSize ?? 60)
    this.embeddingConcurrency = Math.max(1, opts?.embeddingConcurrency ?? 2)
    this.upsertWait = opts?.upsertWait ?? true
    this.searchMinScore = opts?.searchMinScore
    this.searchHnswEf = opts?.searchHnswEf ?? 128
    this.searchExact = opts?.searchExact ?? false
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
        } else if (await this.collectionNeedsSchemaMigration()) {
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
    const body = qdrantCollectionBody(await this.client.getCollection(this.collectionName))
    if (!body) return null
    const config = body["config"] as Record<string, unknown> | undefined
    const params = config?.["params"] as Record<string, unknown> | undefined
    const vectors = params?.["vectors"]
    if (typeof vectors === "number" && Number.isFinite(vectors)) return vectors
    if (vectors && typeof vectors === "object" && "size" in vectors) {
      const size = (vectors as { size?: unknown }).size
      return typeof size === "number" && Number.isFinite(size) ? size : null
    }
    return null
  }

  private async collectionNeedsSchemaMigration(): Promise<boolean> {
    const body = qdrantCollectionBody(await this.client.getCollection(this.collectionName))
    const pointsCount = body?.["points_count"]
    if (typeof pointsCount !== "number" || pointsCount <= 0) return false
    const points = await this.client.retrieve(this.collectionName, {
      ids: [getIndexingMetadataPointId()],
    })
    const version = points[0]?.payload?.["index_schema_version"]
    return version !== INDEX_SCHEMA_VERSION
  }

  /** Create payload indexes used by exact path, path-prefix, and metadata filters. */
  private async ensurePayloadIndexes(): Promise<void> {
    for (const fieldName of ["type", "path", "pathPrefixes"]) {
      try {
        await this.client.createPayloadIndex(this.collectionName, {
          field_name: fieldName,
          field_schema: "keyword",
        })
      } catch (e: unknown) {
        const msg = (e as Error)?.message ?? ""
        if (!msg.toLowerCase().includes("already exists")) {
          console.warn(`[nexus] Vector payload index ${fieldName}:`, (e as Error)?.message)
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
    endLine?: number
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
            if (lastErr instanceof VectorBatchValidationError) throw lastErr
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
      throw err
    }
  }

  private async upsertBatch(symbols: Array<{
    id: string
    path: string
    name: string
    kind?: SymbolKind
    parent?: string
    startLine?: number
    endLine?: number
    content: string
  }>): Promise<void> {
    if (symbols.length === 0) return

    const texts = symbols.map(s =>
      [s.name, s.kind ?? "", s.parent ?? "", s.content.slice(0, 500)].filter(Boolean).join(" ")
    )
    const vectors = await this.embeddings.embed(texts)
    if (vectors.length !== symbols.length) {
      throw new VectorBatchValidationError(
        `Embedding provider returned ${vectors.length} vectors for ${symbols.length} inputs.`,
      )
    }

    const observedSize = vectors[0]?.length ?? 0
    if (observedSize <= 0 || observedSize !== this.vectorSize) {
      throw new VectorBatchValidationError(
        `Embedding vector dimension changed during indexing: expected ${this.vectorSize}, got ${observedSize}. ` +
        "Restart indexing so Nexus can rebuild the collection safely.",
      )
    }
    const invalidVectorIndex = vectors.findIndex(
      (vector) =>
        !Array.isArray(vector) ||
        vector.length !== this.vectorSize ||
        vector.some((value) => !Number.isFinite(value)),
    )
    if (invalidVectorIndex >= 0) {
      throw new VectorBatchValidationError(
        `Embedding provider returned an invalid vector at batch index ${invalidVectorIndex}.`,
      )
    }

    const points = symbols.map((s, i) => {
      const pathPrefixes = pathToPrefixes(s.path)
      return {
        id: toPointId(s.id),
        vector: vectors[i]!,
        payload: {
          path: s.path,
          pathPrefixes,
          name: s.name,
          kind: s.kind ?? "chunk",
          parent: s.parent ?? null,
          startLine: s.startLine ?? 0,
          endLine: s.endLine ?? s.startLine ?? 0,
          content: s.content.slice(0, 1000),
        },
      }
    })

    const upsertOpts = { wait: this.upsertWait }
    await this.client.upsert(this.collectionName, { points, ...upsertOpts })
  }

  async deleteByPath(filePath: string): Promise<void> {
    if (!this.initialized) return
    const normalized = filePath.replace(/\\/g, "/").replace(/^\.\/|\/+$/g, "")
    if (!normalized) return
    await this.client.delete(this.collectionName, {
      filter: { must: [{ key: "path", match: { value: normalized } }] },
      wait: this.upsertWait,
    })
  }

  /** Delete all points under a repo-relative directory prefix (same segment filter as scoped search). */
  async deleteByPathPrefix(dirPrefix: string): Promise<void> {
    if (!this.initialized) return
    const normalized = dirPrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim()
    if (!normalized) return
    await this.client.delete(this.collectionName, {
      filter: {
        must: [{ key: "pathPrefixes", match: { value: normalized } }],
      },
      wait: this.upsertWait,
    })
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
          must.push({ key: "pathPrefixes", match: { value: normalized } })
        }
      }

      const metadataExclusion = {
        must_not: [{ key: "type", match: { value: "metadata" } }],
      }
      const mergedFilter =
        must.length > 0
          ? { must, must_not: metadataExclusion.must_not }
          : metadataExclusion

      /** Unified `query` API against Qdrant. */
      const queryRequest = {
        query: vector,
        filter: mergedFilter,
        limit,
        params: {
          hnsw_ef: this.searchHnswEf,
          exact: this.searchExact,
        },
        with_payload: {
          include: [
            "path",
            "pathPrefixes",
            "name",
            "kind",
            "parent",
            "startLine",
            "endLine",
            "content",
          ],
        },
        ...(this.searchMinScore !== undefined ? { score_threshold: this.searchMinScore } : {}),
      }

      const operationResult = await this.client.query(this.collectionName, queryRequest)
      const rows = pointsFromQueryResponse(operationResult)

      return rows.map(raw => {
        const r = raw as { payload?: Record<string, unknown>; score?: number | null }
        const pl = r.payload
        return {
          path: (pl?.["path"] as string) ?? "",
          name: pl?.["name"] as string | undefined,
          kind: pl?.["kind"] as SymbolKind | undefined,
          parent: pl?.["parent"] as string | undefined,
          startLine: pl?.["startLine"] as number | undefined,
          endLine: pl?.["endLine"] as number | undefined,
          content: (pl?.["content"] as string) ?? "",
          score: r.score ?? undefined,
        }
      }).filter(row => row.path.length > 0 || (row.content?.length ?? 0) > 0)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[nexus] Vector search failed: ${message}`)
      throw err
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
      const body = qdrantCollectionBody(await this.client.getCollection(this.collectionName))
      const pointsCount = body?.["points_count"]
      return typeof pointsCount !== "number" || pointsCount <= 0
    } catch {
      return true
    }
  }

  /** True if at least one non-metadata point exists (partial index during long runs). */
  async hasSearchableCodePoints(): Promise<boolean> {
    if (!this.initialized) return false
    try {
      const res = await this.client.scroll(this.collectionName, {
        filter: { must_not: [{ key: "type", match: { value: "metadata" } }] },
        limit: 1,
        with_payload: false,
        with_vector: false,
      })
      return pointsFromScrollResponse(res).length > 0
    } catch {
      return false
    }
  }

  /**
   * True if collection has data and indexing has been marked complete.
   * Used to avoid treating in-progress or stale index as ready.
   */
  async hasIndexedData(): Promise<boolean> {
    if (!this.initialized) return false
    try {
      const body = qdrantCollectionBody(await this.client.getCollection(this.collectionName))
      const pointsCount = body?.["points_count"]
      if (typeof pointsCount !== "number" || pointsCount <= 0) return false

      const metaId = getIndexingMetadataPointId()
      const points = await this.client.retrieve(this.collectionName, { ids: [metaId] })
      if (points.length > 0) {
        return points[0]?.payload?.indexing_complete === true
      }
      // Collections written before Nexus added completion markers remain readable.
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
          payload: {
            type: "metadata",
            index_schema_version: INDEX_SCHEMA_VERSION,
            indexing_complete: false,
            started_at: Date.now(),
          },
        }],
        wait: this.upsertWait,
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
          payload: {
            type: "metadata",
            index_schema_version: INDEX_SCHEMA_VERSION,
            indexing_complete: true,
            completed_at: Date.now(),
          },
        }],
        wait: this.upsertWait,
      })
    } catch (e) {
      console.warn("[nexus] markIndexingComplete failed:", (e as Error)?.message)
    }
  }

  async clearCollection(): Promise<void> {
    try {
      await this.client.deleteCollection(this.collectionName)
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    } finally {
      this.initialized = false
    }
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
