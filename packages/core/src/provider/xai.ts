import type { ProviderConfig } from "../types.js"
import { createNamedOpenAICompatibleClient } from "./openai-compatible.js"

export function createXAIClient(config: ProviderConfig) {
  return createNamedOpenAICompatibleClient(
    config,
    "xai",
    "https://api.x.ai/v1",
    ["XAI_API_KEY"],
  )
}
