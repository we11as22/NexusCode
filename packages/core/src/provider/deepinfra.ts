import type { ProviderConfig } from "../types.js"
import { createNamedOpenAICompatibleClient } from "./openai-compatible.js"

export function createDeepInfraClient(config: ProviderConfig) {
  return createNamedOpenAICompatibleClient(
    config,
    "deepinfra",
    "https://api.deepinfra.com/v1/openai",
    ["DEEPINFRA_API_KEY"],
  )
}
