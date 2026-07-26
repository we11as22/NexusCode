import { describe, expect, it } from "vitest"

import type { ProviderConfig, ProviderName } from "../types.js"
import { createLLMClient } from "./index.js"

const providers: ProviderName[] = [
  "anthropic",
  "openai",
  "google",
  "ollama",
  "openai-compatible",
  "azure",
  "bedrock",
  "groq",
  "mistral",
  "xai",
  "deepinfra",
  "cerebras",
  "cohere",
  "togetherai",
  "perplexity",
  "minimax",
]

function config(provider: ProviderName): ProviderConfig {
  return {
    provider,
    id: provider === "openai" ? "gpt-4o" : "test-model",
    apiKey: "test-key",
    ...(provider === "openai-compatible"
      ? { baseUrl: "https://compatible.example.test/v1" }
      : {}),
    ...(provider === "azure"
      ? { resourceName: "test-resource", deploymentId: "test-deployment" }
      : {}),
    ...(provider === "bedrock"
      ? {
          extra: {
            region: "us-east-1",
            accessKeyId: "test",
            secretAccessKey: "test",
          },
        }
      : {}),
  }
}

describe("AI SDK runtime compatibility", () => {
  it.each(providers)("%s creates a LanguageModelV1 for the Nexus AI SDK v4 runtime", (provider) => {
    const model = createLLMClient(config(provider)).getModel() as unknown as {
      specificationVersion?: string
    }
    expect(model.specificationVersion).toBe("v1")
  })

  it("normalizes a bare Ollama server URL to its OpenAI-compatible v1 API", () => {
    const model = createLLMClient({
      provider: "ollama",
      id: "qwen3",
      baseUrl: "http://[::1]:11434/",
    }).getModel() as unknown as {
      config: { url(input: { path: string; modelId: string }): string }
    }

    expect(model.config.url({ path: "/chat/completions", modelId: "qwen3" })).toBe(
      "http://[::1]:11434/v1/chat/completions",
    )
  })
})
