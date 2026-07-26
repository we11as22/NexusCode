import type { ProviderConfig } from "../types.js"
import { createNamedOpenAICompatibleClient } from "./openai-compatible.js"

export function createTogetherAIClient(config: ProviderConfig) {
  return createNamedOpenAICompatibleClient(
    config,
    "togetherai",
    "https://api.together.xyz/v1",
    ["TOGETHER_AI_API_KEY", "TOGETHERAI_API_KEY"],
  )
}
