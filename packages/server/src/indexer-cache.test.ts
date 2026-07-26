import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  NexusConfigSchema,
  type CodebaseIndexer,
  type NexusConfig,
} from "@nexuscode/core"
import { ServerIndexerCache } from "./indexer-cache.js"

function config(model = "text-embedding-3-small") {
  return NexusConfigSchema.parse({
    indexing: { enabled: true, vector: true },
    vectorDb: { enabled: true },
    embeddings: {
      provider: "openai",
      model,
      dimensions: 3,
      apiKey: "test",
    },
  }) as NexusConfig
}

function fakeIndexer() {
  return {
    startIndexing: vi.fn(async () => undefined),
    closeAndWait: vi.fn(async () => undefined),
  } as unknown as CodebaseIndexer
}

describe("ServerIndexerCache", () => {
  it("starts one shared indexer for repeated runs in the same workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-server-index-"))
    const indexer = fakeIndexer()
    const create = vi.fn(async () => indexer)
    const cache = new ServerIndexerCache(create, { waitMs: 50 })

    await expect(cache.get(root, config())).resolves.toBe(indexer)
    await expect(cache.get(root, config())).resolves.toBe(indexer)

    expect(create).toHaveBeenCalledOnce()
    expect(indexer.startIndexing).toHaveBeenCalledOnce()
  })

  it("stops the old workspace indexer before applying incompatible config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-server-index-config-"))
    const first = fakeIndexer()
    const second = fakeIndexer()
    const create = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
    const cache = new ServerIndexerCache(create, { waitMs: 50 })

    await cache.get(root, config("first"))
    await expect(cache.get(root, config("second"))).resolves.toBe(second)

    expect(first.closeAndWait).toHaveBeenCalledOnce()
    expect(second.startIndexing).toHaveBeenCalledOnce()
  })
})
