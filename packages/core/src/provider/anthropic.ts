import { createAnthropic } from "@ai-sdk/anthropic"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"
import { resolveProviderCredential } from "./credential-identity.js"

export function createAnthropicClient(config: ProviderConfig) {
  const apiKey = resolveProviderCredential(config).apiKey ?? ""
  const anthropic = createAnthropic({
    apiKey,
    baseURL: config.baseUrl,
  })

  const model = anthropic(config.id, {
    cacheControl: true,
  })

  return new BaseLLMClient(model as any, "anthropic", config.id)
}
