import { createMistral } from "@ai-sdk/mistral"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createMistralClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["MISTRAL_API_KEY"] ?? ""
  const mistral = createMistral({ apiKey, baseURL: config.baseUrl })
  return new BaseLLMClient(mistral(config.id), "mistral", config.id)
}
