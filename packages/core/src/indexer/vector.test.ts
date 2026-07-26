import { describe, expect, it, vi } from "vitest"
import type { EmbeddingClient } from "../provider/types.js"
import { VectorIndex } from "./vector.js"

function createVector(
  embed: EmbeddingClient["embed"],
  client: Record<string, unknown>,
): VectorIndex {
  const embeddings: EmbeddingClient = {
    dimensions: 3,
    embed,
  }
  const vector = new VectorIndex("http://localhost:6333", "test", embeddings)
  const internals = vector as unknown as {
    client: Record<string, unknown>
    initialized: boolean
    vectorSize: number
  }
  internals.client = client
  internals.initialized = true
  internals.vectorSize = 3
  return vector
}

describe("VectorIndex consistency", () => {
  it("rejects partial embedding batches instead of marking missing vectors indexed", async () => {
    const upsert = vi.fn()
    const embed = vi.fn(async () => [[0.1, 0.2, 0.3]])
    const vector = createVector(
      embed,
      { upsert },
    )

    await expect(vector.upsertSymbols([
      { id: "one", path: "src/one.ts", name: "one", content: "one" },
      { id: "two", path: "src/two.ts", name: "two", content: "two" },
    ])).rejects.toThrow("returned 1 vectors for 2 inputs")
    expect(embed).toHaveBeenCalledOnce()
    expect(upsert).not.toHaveBeenCalled()
  })

  it("deletes an exact file path without deleting siblings that share a deep prefix", async () => {
    const deletePoints = vi.fn(async () => undefined)
    const vector = createVector(
      vi.fn(async () => [[0.1, 0.2, 0.3]]),
      { delete: deletePoints },
    )

    await vector.deleteByPath("a/b/c/d/e/one.ts")

    expect(deletePoints).toHaveBeenCalledWith(
      "nexus_test",
      {
        filter: {
          must: [{ key: "path", match: { value: "a/b/c/d/e/one.ts" } }],
        },
        wait: true,
      },
    )
  })

  it("uses a complete path-prefix payload for scoped search", async () => {
    const query = vi.fn(async () => ({ points: [] }))
    const vector = createVector(
      vi.fn(async () => [[0.1, 0.2, 0.3]]),
      { query },
    )

    await vector.search("auth", 5, undefined, "a/b/c/d/e/deep")

    expect(query).toHaveBeenCalledWith(
      "nexus_test",
      expect.objectContaining({
        filter: expect.objectContaining({
          must: [{ key: "pathPrefixes", match: { value: "a/b/c/d/e/deep" } }],
        }),
      }),
    )
  })

  it("does not report an explicitly incomplete collection as ready", async () => {
    const vector = createVector(
      vi.fn(async () => [[0.1, 0.2, 0.3]]),
      {
        getCollection: vi.fn(async () => ({ points_count: 2 })),
        retrieve: vi.fn(async () => [{
          payload: {
            type: "metadata",
            indexing_complete: false,
          },
        }]),
      },
    )

    await expect(vector.hasIndexedData()).resolves.toBe(false)
  })

  it("does not hide collection deletion failures", async () => {
    const vector = createVector(
      vi.fn(async () => [[0.1, 0.2, 0.3]]),
      {
        deleteCollection: vi.fn(async () => {
          throw new Error("Qdrant unavailable")
        }),
      },
    )

    await expect(vector.clearCollection()).rejects.toThrow("Qdrant unavailable")
  })

  it("surfaces search outages instead of returning a false no-results answer", async () => {
    const vector = createVector(
      vi.fn(async () => [[0.1, 0.2, 0.3]]),
      {
        query: vi.fn(async () => {
          throw new Error("Qdrant unavailable")
        }),
      },
    )

    await expect(vector.search("auth", 5)).rejects.toThrow("Qdrant unavailable")
  })
})
