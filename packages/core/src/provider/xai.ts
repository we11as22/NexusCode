import { createXai } from "@ai-sdk/xai"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createXAIClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["XAI_API_KEY"] ?? ""
  const xai = createXai({ apiKey })
  return new BaseLLMClient(xai(config.id) as any, "xai", config.id)
}
