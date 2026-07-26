import type { ProviderConfig } from "../types.js"
import { createNamedOpenAICompatibleClient } from "./openai-compatible.js"

export function createCerebrasClient(config: ProviderConfig) {
  return createNamedOpenAICompatibleClient(
    config,
    "cerebras",
    "https://api.cerebras.ai/v1",
    ["CEREBRAS_API_KEY"],
  )
}
