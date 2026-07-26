import { describe, expect, it } from "vitest"
import { parseQdrantUrl } from "./qdrant-client-factory.js"

describe("parseQdrantUrl", () => {
  it.each([
    [undefined, "http://localhost:6333"],
    ["", "http://localhost:6333"],
    ["localhost", "http://localhost:6333"],
    ["qdrant.internal", "http://qdrant.internal:6333"],
    ["localhost:7444", "http://localhost:7444"],
    ["https://cloud.qdrant.io", "https://cloud.qdrant.io"],
    ["https://cloud.qdrant.io/prefix/", "https://cloud.qdrant.io/prefix"],
  ])("normalizes %s", (input, expected) => {
    expect(parseQdrantUrl(input)).toBe(expected)
  })
})
