import { QdrantClient } from "@qdrant/js-client-rest"
import type { IndexSearchResult, SymbolKind } from "../types.js"
import type { EmbeddingClient } from "../provider/types.js"

/**
 * Qdrant vector store for semantic code search.
 * One collection per project, named nexus_{project_hash}.
 */
export class VectorIndex {
  private client: QdrantClient
  private collectionName: string
  private embeddings: EmbeddingClient
  private initialized = false
  readonly dimensions: number

  constructor(
    url: string,
    projectHash: string,
    embeddings: EmbeddingClient
  ) {
    this.client = new QdrantClient({ url })
    this.collectionName = `nexus_${projectHash}`
    this.embeddings = embeddings
    this.dimensions = embeddings.dimensions
  }

  async init(): Promise<void> {
    try {
      // Create collection if it doesn't exist
      const collections = await this.client.getCollections()
      const exists = collections.collections.some(c => c.name === this.collectionName)

      if (!exists) {
        await this.client.createCollection(this.collectionName, {
          vectors: {
            size: this.dimensions,
            distance: "Cosine",
          },
        })
      }

      this.initialized = true
    } catch (err) {
      throw new Error(`Failed to initialize Qdrant collection: ${(err as Error).message}`)
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
  }>): Promise<void> {
    if (!this.initialized || symbols.length === 0) return

    try {
      const texts = symbols.map(s =>
        [s.name, s.kind ?? "", s.parent ?? "", s.content.slice(0, 500)].filter(Boolean).join(" ")
      )
      const vectors = await this.embeddings.embed(texts)

      const points = symbols.map((s, i) => ({
        id: stringToUint(s.id),
        vector: vectors[i]!,
        payload: {
          path: s.path,
          name: s.name,
          kind: s.kind ?? "chunk",
          parent: s.parent ?? null,
          startLine: s.startLine ?? 0,
          content: s.content.slice(0, 1000),
        },
      }))

      await this.client.upsert(this.collectionName, { points })
    } catch (err) {
      console.warn("[nexus] Vector upsert failed:", err)
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
      console.warn("[nexus] Vector search failed:", err)
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
}

function stringToUint(str: string): number {
  // Simple deterministic hash for Qdrant point IDs
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash)
}
