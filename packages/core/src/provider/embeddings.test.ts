import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig } from "../types.js"
import { createEmbeddingClient, isEmbeddingApiKeyMissing } from "./embeddings.js"

function embedding(
  provider: EmbeddingConfig["provider"],
  overrides: Partial<EmbeddingConfig> = {},
): EmbeddingConfig {
  return {
    provider,
    model: "test",
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  for (const name of [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "NEXUS_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
  ]) {
    vi.stubEnv(name, "")
  }
})

describe("embedding credential discovery", () => {
  it("uses the provider-specific Google and Mistral environment variables", () => {
    vi.stubEnv("GEMINI_API_KEY", "google-key")
    vi.stubEnv("MISTRAL_API_KEY", "mistral-key")

    expect(isEmbeddingApiKeyMissing(embedding("google"))).toBe(false)
    expect(isEmbeddingApiKeyMissing(embedding("mistral"))).toBe(false)
  })

  it("allows Bedrock to use the standard AWS credential chain", () => {
    expect(isEmbeddingApiKeyMissing(embedding("bedrock"))).toBe(false)
  })

  it("recognizes IPv6 loopback as a keyless OpenAI-compatible endpoint", () => {
    expect(isEmbeddingApiKeyMissing(embedding("openai-compatible", {
      baseUrl: "http://[::1]:8080/v1",
    }))).toBe(false)
  })

  it("still requires credentials for a remote compatible endpoint", () => {
    expect(isEmbeddingApiKeyMissing(embedding("openai-compatible", {
      baseUrl: "https://embeddings.example.com/v1",
    }))).toBe(true)
  })
})

describe("offline local embeddings", () => {
  it("produces deterministic normalized vectors without an optional runtime dependency", async () => {
    const client = createEmbeddingClient(embedding("local", { dimensions: 128 }))
    const [first, repeated, related, unrelated] = await client.embed([
      "parse TypeScript source files",
      "parse TypeScript source files",
      "TypeScript parser for source code",
      "banana orchard irrigation",
    ])
    const similarity = (left: number[], right: number[]) =>
      left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0)
    const norm = (values: number[]) =>
      Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))

    expect(first).toEqual(repeated)
    expect(first).toHaveLength(128)
    expect(norm(first)).toBeCloseTo(1, 8)
    expect(similarity(first, related)).toBeGreaterThan(similarity(first, unrelated))
  })
})

describe("embedding SDK compatibility", () => {
  it("uses the AI SDK v4-compatible OpenAI protocol for Mistral embeddings", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      data: [{ embedding: [0.25, 0.75], index: 0 }],
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))
    vi.stubGlobal("fetch", fetchMock)

    const client = createEmbeddingClient(embedding("mistral", {
      apiKey: "test-key",
      model: "mistral-embed",
      dimensions: 2,
    }))
    await expect(client.embed(["hello"])).resolves.toEqual([[0.25, 0.75]])
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.mistral.ai/v1/embeddings")
  })

  it("normalizes a bare Ollama URL to the v1 embeddings endpoint", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      data: [{ embedding: [1], index: 0 }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }))
    vi.stubGlobal("fetch", fetchMock)

    const client = createEmbeddingClient(embedding("ollama", {
      baseUrl: "http://localhost:11434/",
      dimensions: 1,
    }))
    await expect(client.embed(["hello"])).resolves.toEqual([[1]])
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://localhost:11434/v1/embeddings")
  })
})
