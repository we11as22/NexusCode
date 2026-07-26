import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import path from "node:path"
import {
  createCodebaseIndexer,
  type CodebaseIndexer,
  type IndexerFactoryOptions,
  type NexusConfig,
} from "@nexuscode/core"

type CreateIndexer = (
  root: string,
  config: NexusConfig,
  options?: IndexerFactoryOptions,
) => Promise<CodebaseIndexer>

interface CacheEntry {
  fingerprint: string
  promise: Promise<CodebaseIndexer>
  lastUsedAt: number
}

export interface ServerIndexerCacheOptions {
  waitMs?: number
  maxWorkspaces?: number
}

function indexConfigFingerprint(config: NexusConfig): string {
  const relevant = {
    indexing: config.indexing,
    vectorDb: config.vectorDb,
    embeddings: config.embeddings,
  }
  return createHash("sha256")
    .update(JSON.stringify(relevant))
    .digest("hex")
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * One long-lived semantic indexer per server workspace. Late initialization is
 * retained after a request timeout, so the next request can use the ready
 * indexer instead of leaking and recreating it.
 */
export class ServerIndexerCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly waitMs: number
  private readonly maxWorkspaces: number

  constructor(
    private readonly createIndexer: CreateIndexer = createCodebaseIndexer,
    options: ServerIndexerCacheOptions = {},
  ) {
    this.waitMs = Math.max(1, options.waitMs ?? 2_500)
    this.maxWorkspaces = Math.max(1, options.maxWorkspaces ?? 8)
  }

  async get(
    cwd: string,
    config: NexusConfig,
    options: IndexerFactoryOptions = {},
  ): Promise<CodebaseIndexer | undefined> {
    const root = await realpath(cwd).catch(() => path.resolve(cwd))
    const fingerprint = indexConfigFingerprint(config)
    const existing = this.entries.get(root)
    if (existing?.fingerprint === fingerprint) {
      existing.lastUsedAt = Date.now()
      return within(existing.promise, this.waitMs)
    }

    const previousClose = existing
      ? existing.promise
          .then((indexer) => indexer.closeAndWait())
          .catch(() => undefined)
      : Promise.resolve()

    let entry!: CacheEntry
    const promise = (async () => {
      await previousClose
      const indexer = await this.createIndexer(root, config, options)
      await indexer.startIndexing()
      return indexer
    })()
    entry = {
      fingerprint,
      promise,
      lastUsedAt: Date.now(),
    }
    this.entries.set(root, entry)
    void promise.catch(() => {
      if (this.entries.get(root) === entry) this.entries.delete(root)
    })
    this.evictOverflow(root)
    return within(promise, this.waitMs)
  }

  private evictOverflow(currentRoot: string): void {
    if (this.entries.size <= this.maxWorkspaces) return
    const candidate = [...this.entries.entries()]
      .filter(([root]) => root !== currentRoot)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0]
    if (!candidate) return
    const [root, entry] = candidate
    this.entries.delete(root)
    void entry.promise
      .then((indexer) => indexer.closeAndWait())
      .catch(() => undefined)
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.allSettled(
      entries.map(async (entry) => {
        const indexer = await entry.promise
        await indexer.closeAndWait()
      }),
    )
  }
}

export const serverIndexerCache = new ServerIndexerCache()
