import { createAnthropic } from "@ai-sdk/anthropic"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createAnthropicClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? ""
  const anthropic = createAnthropic({
    apiKey,
    baseURL: config.baseUrl,
  })

  const model = anthropic(config.id, {
    cacheControl: true,
  })

  return new BaseLLMClient(model as any, "anthropic", config.id)
}
