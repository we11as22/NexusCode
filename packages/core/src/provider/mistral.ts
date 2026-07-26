import type { ProviderConfig } from "../types.js"
import { createNamedOpenAICompatibleClient } from "./openai-compatible.js"

export function createMistralClient(config: ProviderConfig) {
  return createNamedOpenAICompatibleClient(
    config,
    "mistral",
    "https://api.mistral.ai/v1",
    ["MISTRAL_API_KEY"],
  )
}
