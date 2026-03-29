import * as crypto from "node:crypto"
import type { NexusConfig } from "../types.js"
import { createEmbeddingClient, isEmbeddingApiKeyMissing } from "../provider/index.js"
import { CodebaseIndexer } from "./index.js"
import { ensureQdrantRunning } from "./qdrant-manager.js"
import type { CodebaseIndexerHostOptions, ListIndexAbsolutePathsFn } from "./host-types.js"

export type { ListIndexAbsolutePathsFn, CodebaseIndexerHostOptions }

export interface IndexerFactoryOptions {
  onWarning?: (message: string) => void
  /** Progress messages during Qdrant startup and indexer creation (e.g. for UI or terminal). */
  onProgress?: (message: string) => void
  /** Max ms to wait for Qdrant when vector is enabled (e.g. 2500 for fast first message). Omit for default 20s. */
  maxQdrantWaitMs?: number
  /** VS Code: ripgrep `listFiles` parity. Omit = recursive `walkDir` in core. */
  listAbsolutePaths?: ListIndexAbsolutePathsFn
  /** VS Code `globalStorageUri` JSON path for file hashes (Roo `CacheManager` parity). */
  fileTrackerJsonPath?: string
}

function hostOptsFromFactory(options: IndexerFactoryOptions): CodebaseIndexerHostOptions | undefined {
  if (!options.listAbsolutePaths && !options.fileTrackerJsonPath) return undefined
  return {
    listAbsolutePaths: options.listAbsolutePaths,
    fileTrackerJsonPath: options.fileTrackerJsonPath,
  }
}

/**
 * Creates a CodebaseIndexer with optional vector search (Qdrant).
 * When vector prerequisites are missing, returns indexer without vector (no semantic search; agent works without codebase_search).
 */
export async function createCodebaseIndexer(
  projectRoot: string,
  config: NexusConfig,
  options: IndexerFactoryOptions = {}
): Promise<CodebaseIndexer> {
  const warn = options.onWarning ?? (() => {})
  const progress = options.onProgress ?? (() => {})
  const maxQdrantWaitMs = options.maxQdrantWaitMs
  const wantsVector = Boolean(config.indexing.vector && config.vectorDb?.enabled)
  const host = hostOptsFromFactory(options)

  if (!wantsVector) {
    return new CodebaseIndexer(projectRoot, config, undefined, undefined, undefined, host)
  }

  if (!config.embeddings) {
    warn("[nexus] Vector indexing is enabled but embeddings config is missing. Indexer will run without vector search.")
    return new CodebaseIndexer(projectRoot, config, undefined, undefined, undefined, host)
  }

  if (isEmbeddingApiKeyMissing(config.embeddings)) {
    warn("[nexus] Vector indexing is enabled but embeddings API key is missing. Nexus will run without vector search. Add embeddings.apiKey or set OPENROUTER_API_KEY / OPENAI_API_KEY to enable it later.")
    return new CodebaseIndexer(projectRoot, config, undefined, undefined, undefined, host)
  }

  const vectorUrl = config.vectorDb?.url ?? "http://127.0.0.1:6333"
  const autoStart = config.vectorDb?.autoStart ?? true
  progress("Starting vector DB (Qdrant)…")
  const qdrant = await ensureQdrantRunning({
    url: vectorUrl,
    autoStart,
    log: warn,
    onProgress: progress,
    ...(maxQdrantWaitMs != null && { maxWaitMs: maxQdrantWaitMs }),
  })
  if (!qdrant.available) {
    warn(qdrant.warning ?? "[nexus] Qdrant is unavailable. Indexer will run without vector search.")
    return new CodebaseIndexer(projectRoot, config, undefined, undefined, undefined, host)
  }

  progress("Creating embedding client…")
  let embeddingClient
  try {
    embeddingClient = createEmbeddingClient(config.embeddings)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn(`[nexus] Embeddings init failed (${msg}). Indexer will run without vector search. Set embeddings.apiKey or env (e.g. OPENROUTER_API_KEY) if using a remote embeddings API.`)
    return new CodebaseIndexer(projectRoot, config, undefined, undefined, undefined, host)
  }
  const projectHash = crypto.createHash("sha1").update(projectRoot).digest("hex").slice(0, 16)

  progress("Vector DB ready. Preparing index…")
  return new CodebaseIndexer(projectRoot, config, embeddingClient, vectorUrl, projectHash, host)
}
