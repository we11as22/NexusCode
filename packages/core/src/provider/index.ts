import type { ProviderConfig, EmbeddingConfig } from "../types.js"
import type { LLMClient, EmbeddingClient } from "./types.js"
import { createAnthropicClient } from "./anthropic.js"
import { createOpenAIClient } from "./openai.js"
import { createGoogleClient } from "./google.js"
import { createOpenAICompatibleClient, createOllamaClient } from "./openai-compatible.js"
import { createAzureClient } from "./azure.js"
import { createBedrockClient } from "./bedrock.js"
import { createGroqClient } from "./groq.js"
import { createMistralClient } from "./mistral.js"
import { createXAIClient } from "./xai.js"
import { createDeepInfraClient } from "./deepinfra.js"
import { createCerebrasClient } from "./cerebras.js"
import { createCohereClient } from "./cohere.js"
import { createTogetherAIClient } from "./togetherai.js"
import { createPerplexityClient } from "./perplexity.js"
import { createMiniMaxClient } from "./minimax.js"
import { createEmbeddingClient, isEmbeddingApiKeyMissing } from "./embeddings.js"

export function createLLMClient(config: ProviderConfig): LLMClient {
  switch (config.provider) {
    case "anthropic":
      return createAnthropicClient(config)
    case "openai":
      return createOpenAIClient(config)
    case "google":
      return createGoogleClient(config)
    case "ollama":
      return createOllamaClient(config)
    case "openai-compatible":
      return createOpenAICompatibleClient(config)
    case "azure":
      return createAzureClient(config)
    case "bedrock":
      return createBedrockClient(config)
    case "groq":
      return createGroqClient(config)
    case "mistral":
      return createMistralClient(config)
    case "xai":
      return createXAIClient(config)
    case "deepinfra":
      return createDeepInfraClient(config)
    case "cerebras":
      return createCerebrasClient(config)
    case "cohere":
      return createCohereClient(config)
    case "togetherai":
      return createTogetherAIClient(config)
    case "perplexity":
      return createPerplexityClient(config)
    case "minimax":
      return createMiniMaxClient(config)
    default:
      throw new Error(`Unknown provider: ${(config as ProviderConfig).provider}`)
  }
}

export { createEmbeddingClient, isEmbeddingApiKeyMissing }
export type { LLMClient, EmbeddingClient }
export * from "./types.js"
