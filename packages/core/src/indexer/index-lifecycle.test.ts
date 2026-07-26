import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { createTestConfig } from "../test/fakes.js"
import { FileTracker } from "./file-tracker.js"
import { CodebaseIndexer } from "./index.js"

describe("CodebaseIndexer lifecycle", () => {
  it("fully stops the previous pass before starting a replacement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-index-lifecycle-"))
    const config = createTestConfig({
      indexing: { vector: false, maxIndexedFiles: 1 },
    })
    const indexer = new CodebaseIndexer(
      root,
      config,
      undefined,
      undefined,
      undefined,
      { fileTrackerJsonPath: path.join(root, "tracker.json") },
    )
    let active = 0
    let maxActive = 0
    const signals: AbortSignal[] = []
    const internals = indexer as unknown as {
      indexInBackground: (signal: AbortSignal) => Promise<void>
    }
    internals.indexInBackground = async (signal) => {
      signals.push(signal)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      })
      active -= 1
    }

    await indexer.startIndexing()
    await indexer.startIndexing()

    expect(signals).toHaveLength(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    expect(maxActive).toBe(1)

    indexer.stop()
  })

  it("preserves tracker state when Qdrant cannot clear the collection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nexus-index-delete-"))
    const trackerPath = path.join(root, "tracker.json")
    const config = createTestConfig({
      indexing: { vector: true, maxIndexedFiles: 1 },
      vectorDb: { enabled: true },
    })
    const indexer = new CodebaseIndexer(
      root,
      config,
      undefined,
      undefined,
      undefined,
      { fileTrackerJsonPath: trackerPath },
    )
    const tracker = new FileTracker(root, trackerPath)
    await tracker.load()
    tracker.upsertFile("src/keep.ts", "hash", 1)
    await tracker.save()
    const internals = indexer as unknown as {
      vector: { clearCollection: () => Promise<void> }
    }
    internals.vector = {
      clearCollection: async () => {
        throw new Error("Qdrant unavailable")
      },
    }

    await expect(indexer.deleteIndex()).rejects.toThrow("Qdrant unavailable")

    const reloaded = new FileTracker(root, trackerPath)
    await reloaded.load()
    expect(reloaded.listPaths()).toEqual(["src/keep.ts"])
  })
})
