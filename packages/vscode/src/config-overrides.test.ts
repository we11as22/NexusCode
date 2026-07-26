import { describe, expect, it } from "vitest"
import { NexusConfigSchema, type NexusConfig } from "@nexuscode/core"
import {
  applyExplicitConfigOverrides,
  type ExplicitSettingReader,
} from "./config-overrides.js"

function config(overrides: Record<string, unknown> = {}): NexusConfig {
  return NexusConfigSchema.parse(overrides) as NexusConfig
}

function reader(values: Record<string, unknown>): ExplicitSettingReader {
  return <T>(key: string) => values[key] as T | undefined
}

describe("applyExplicitConfigOverrides", () => {
  it("does not let VS Code contribution defaults overwrite nexus.yaml", () => {
    const target = config({
      model: { provider: "google", id: "gemini-custom", temperature: 0.7 },
      indexing: { enabled: false },
    })
    const before = structuredClone(target)

    applyExplicitConfigOverrides(target, reader({}))

    expect(target).toEqual(before)
  })

  it("merges explicit model, permissions, indexing, vector and local embedding settings", () => {
    const target = config()

    applyExplicitConfigOverrides(target, reader({
      provider: "openrouter",
      model: "openai/gpt-4.1",
      temperature: 5,
      enableCheckpoints: false,
      autoApproveRead: false,
      autoApproveMcp: true,
      enableIndexing: true,
      enableVectorIndex: true,
      embeddingBatchSize: 12.9,
      embeddingConcurrency: 3.8,
      enableVectorDb: true,
      vectorDbUrl: " http://qdrant.internal:6333 ",
      vectorDbAutoStart: false,
      embeddingsProvider: "local",
      embeddingsDimensions: 256.9,
      toolClassifyThreshold: 31.7,
      skillClassifyThreshold: 17.2,
    }))

    expect(target.model).toMatchObject({
      provider: "openai-compatible",
      id: "openai/gpt-4.1",
      baseUrl: "https://openrouter.ai/api/v1",
      temperature: 2,
    })
    expect(target.checkpoint.enabled).toBe(false)
    expect(target.permissions.autoApproveRead).toBe(false)
    expect(target.permissions.autoApproveMcp).toBe(true)
    expect(target.indexing).toMatchObject({
      enabled: true,
      vector: true,
      embeddingBatchSize: 12,
      embeddingConcurrency: 3,
    })
    expect(target.vectorDb).toMatchObject({
      enabled: true,
      url: "http://qdrant.internal:6333",
      autoStart: false,
    })
    expect(target.embeddings).toEqual({
      provider: "local",
      model: "feature-hashing-v1",
      dimensions: 256,
    })
    expect(target.tools.classifyThreshold).toBe(31)
    expect(target.skillClassifyThreshold).toBe(17)
  })

  it("rejects invalid provider and numeric overrides without corrupting valid config", () => {
    const target = config({
      model: { provider: "anthropic", id: "claude-custom", temperature: 0.4 },
      embeddings: { provider: "mistral", model: "mistral-embed" },
      indexing: { embeddingConcurrency: 4 },
    })

    applyExplicitConfigOverrides(target, reader({
      provider: "made-up-provider",
      embeddingsProvider: "made-up-embeddings",
      temperature: Number.NaN,
      contextWindow: 0,
      embeddingConcurrency: -3,
      embeddingsDimensions: Number.POSITIVE_INFINITY,
      toolClassifyThreshold: 0,
    }))

    expect(target.model).toMatchObject({
      provider: "anthropic",
      id: "claude-custom",
      temperature: 0.4,
    })
    expect(target.embeddings).toEqual({
      provider: "mistral",
      model: "mistral-embed",
    })
    expect(target.indexing.embeddingConcurrency).toBe(4)
  })
})
