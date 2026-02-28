import type { ProviderConfig, EmbeddingConfig } from "../types.js"
import type { LLMClient, EmbeddingClient } from "./types.js"
import { createAnthropicClient } from "./anthropic.js"
import { createOpenAIClient } from "./openai.js"
import { createGoogleClient } from "./google.js"
import { createOpenRouterClient } from "./openrouter.js"
import { createOpenAICompatibleClient, createOllamaClient } from "./openai-compatible.js"
import { createAzureClient } from "./azure.js"
import { createBedrockClient } from "./bedrock.js"
import { createEmbeddingClient } from "./embeddings.js"

export function createLLMClient(config: ProviderConfig): LLMClient {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicClient(config)
    case "openai":
      return createOpenAIClient(config)
    case "google":
      return createGoogleClient(config)
    case "openrouter":
      return createOpenRouterClient(config)
    case "ollama":
      return createOllamaClient(config)
    case "openai-compatible":
      return createOpenAICompatibleClient(config)
    case "azure":
      return createAzureClient(config)
    case "bedrock":
      return createBedrockClient(config)
    default:
      throw new Error(`Unknown provider: ${(config as ProviderConfig).provider}`)
  }
}

export { createEmbeddingClient }
export type { LLMClient, EmbeddingClient }
export * from "./types.js"
