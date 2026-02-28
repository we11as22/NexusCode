import { createPerplexity } from "@ai-sdk/perplexity"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createPerplexityClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["PERPLEXITY_API_KEY"] ?? ""
  const perplexity = createPerplexity({ apiKey })
  return new BaseLLMClient(perplexity(config.id), "perplexity", config.id)
}
