import * as crypto from "node:crypto"
import type { NexusConfig } from "../types.js"
import { createEmbeddingClient } from "../provider/index.js"
import { CodebaseIndexer } from "./index.js"
import { ensureQdrantRunning } from "./qdrant-manager.js"

export interface IndexerFactoryOptions {
  onWarning?: (message: string) => void
}

/**
 * Creates a CodebaseIndexer with optional vector-search wiring.
 * If vector prerequisites are missing, falls back to FTS-only indexer.
 */
export async function createCodebaseIndexer(
  projectRoot: string,
  config: NexusConfig,
  options: IndexerFactoryOptions = {}
): Promise<CodebaseIndexer> {
  const warn = options.onWarning ?? (() => {})
  const wantsVector = Boolean(config.indexing.vector && config.vectorDb?.enabled)

  if (!wantsVector) {
    return new CodebaseIndexer(projectRoot, config)
  }

  if (!config.embeddings) {
    warn("[nexus] Vector indexing is enabled but embeddings config is missing. Falling back to FTS-only index.")
    return new CodebaseIndexer(projectRoot, config)
  }

  const vectorUrl = config.vectorDb?.url ?? "http://127.0.0.1:6333"
  const autoStart = config.vectorDb?.autoStart ?? true
  const qdrant = await ensureQdrantRunning({
    url: vectorUrl,
    autoStart,
    log: warn,
  })
  if (!qdrant.available) {
    warn(qdrant.warning ?? "[nexus] Qdrant is unavailable. Falling back to FTS-only index.")
    return new CodebaseIndexer(projectRoot, config)
  }

  let embeddingClient
  try {
    embeddingClient = createEmbeddingClient(config.embeddings)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn(`[nexus] Embeddings init failed (${msg}). Falling back to FTS-only index.`)
    return new CodebaseIndexer(projectRoot, config)
  }
  const projectHash = crypto.createHash("sha1").update(projectRoot).digest("hex").slice(0, 16)

  return new CodebaseIndexer(projectRoot, config, embeddingClient, vectorUrl, projectHash)
}
