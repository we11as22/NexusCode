import { createCohere } from "@ai-sdk/cohere"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createCohereClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["COHERE_API_KEY"] ?? ""
  const cohere = createCohere({ apiKey })
  return new BaseLLMClient(cohere(config.id), "cohere", config.id)
}
