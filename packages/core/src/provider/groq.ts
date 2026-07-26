import type { ProviderConfig } from "../types.js"
import { createNamedOpenAICompatibleClient } from "./openai-compatible.js"

export function createGroqClient(config: ProviderConfig) {
  return createNamedOpenAICompatibleClient(
    config,
    "groq",
    "https://api.groq.com/openai/v1",
    ["GROQ_API_KEY"],
  )
}
