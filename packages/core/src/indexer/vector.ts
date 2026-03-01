import { QdrantClient } from "@qdrant/js-client-rest"
import type { IndexSearchResult, SymbolKind } from "../types.js"
import type { EmbeddingClient } from "../provider/types.js"
import crypto from "node:crypto"

/**
 * Qdrant vector store for semantic code search.
 * One collection per project, named nexus_{project_hash}.
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
          },
        })
      }

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

  async upsertSymbols(symbols: Array<{
    id: string
    path: string
    name: string
    kind?: SymbolKind
    parent?: string
    startLine?: number
    content: string
  }>): Promise<void> {
    if (!this.initialized || symbols.length === 0) return

    try {
      const batches = chunk(symbols, this.embeddingBatchSize)

      for (let i = 0; i < batches.length; i += this.embeddingConcurrency) {
        const group = batches.slice(i, i + this.embeddingConcurrency)
        await Promise.all(group.map(batch => this.upsertBatch(batch)))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
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

    const points = symbols.map((s, i) => ({
      id: toPointId(s.id),
      vector: vectors[i]!,
      payload: {
        path: s.path,
        name: s.name,
        kind: s.kind ?? "chunk",
        parent: s.parent ?? null,
        startLine: s.startLine ?? 0,
        content: s.content.slice(0, 1000),
      },
    })).filter(p => Array.isArray(p.vector) && p.vector.length === this.vectorSize)

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
      await this.client.delete(this.collectionName, {
        filter: { must: [{ key: "path", match: { value: filePath } }] },
      })
    } catch {}
  }

  async search(
    query: string,
    limit: number,
    kind?: SymbolKind
  ): Promise<IndexSearchResult[]> {
    if (!this.initialized) return []

    try {
      const [vector] = await this.embeddings.embed([query])
      if (!vector) return []

      const filter = kind
        ? { must: [{ key: "kind", match: { value: kind } }] }
        : undefined

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
      },
    })
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
