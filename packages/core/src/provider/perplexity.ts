import type { ProviderConfig } from "../types.js"
import { createNamedOpenAICompatibleClient } from "./openai-compatible.js"

export function createPerplexityClient(config: ProviderConfig) {
  return createNamedOpenAICompatibleClient(
    config,
    "perplexity",
    "https://api.perplexity.ai",
    ["PERPLEXITY_API_KEY"],
  )
}
