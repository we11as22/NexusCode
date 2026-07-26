import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EmbeddingConfig } from "../types.js"
import { isEmbeddingApiKeyMissing } from "./embeddings.js"

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
