import { createAnthropic } from "@ai-sdk/anthropic"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

function toMiniMaxAnthropicBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? "https://api.minimax.io/anthropic").trim()
  if (raw.endsWith("/v1")) return raw.replace(/\/v1$/, "/anthropic")
  if (raw.endsWith("/anthropic")) return raw
  return `${raw.replace(/\/$/, "")}/anthropic`
}

export function createMiniMaxClient(config: ProviderConfig) {
  const apiKey =
    config.apiKey ??
    process.env["MINIMAX_API_KEY"] ??
    ""

  const anthropic = createAnthropic({
    apiKey,
    baseURL: toMiniMaxAnthropicBaseUrl(config.baseUrl),
  })

  const model = anthropic(config.id, {
    cacheControl: true,
  })

  return new BaseLLMClient(model as any, "minimax", config.id)
}
