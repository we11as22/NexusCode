import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createOpenRouterClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["OPENROUTER_API_KEY"] ?? ""
  const openrouter = createOpenRouter({ apiKey })
  const model = openrouter(config.id)
  return new BaseLLMClient(model as any, "openrouter", config.id)
}
