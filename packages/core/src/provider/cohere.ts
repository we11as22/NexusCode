import type { ProviderConfig } from "../types.js"
import { createNamedOpenAICompatibleClient } from "./openai-compatible.js"

export function createCohereClient(config: ProviderConfig) {
  return createNamedOpenAICompatibleClient(
    config,
    "cohere",
    "https://api.cohere.com/compatibility/v1",
    ["COHERE_API_KEY"],
  )
}
