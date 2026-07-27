import { createAnthropic } from "@ai-sdk/anthropic"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"
import { resolveProviderCredential } from "./credential-identity.js"

function toMiniMaxAnthropicBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? "https://api.minimax.io/anthropic").trim()
  if (raw.endsWith("/v1")) return raw.replace(/\/v1$/, "/anthropic")
  if (raw.endsWith("/anthropic")) return raw
  return `${raw.replace(/\/$/, "")}/anthropic`
}

export function createMiniMaxClient(config: ProviderConfig) {
  const baseURL = toMiniMaxAnthropicBaseUrl(config.baseUrl)
  const apiKey = resolveProviderCredential({
    ...config,
    baseUrl: baseURL,
  }).apiKey ?? ""

  const anthropic = createAnthropic({
    apiKey,
    baseURL,
  })

  const model = anthropic(config.id, {
    cacheControl: true,
  })

  return new BaseLLMClient(model as any, "minimax", config.id)
}
