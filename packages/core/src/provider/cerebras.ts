import { createCerebras } from "@ai-sdk/cerebras"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createCerebrasClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["CEREBRAS_API_KEY"] ?? ""
  const cerebras = createCerebras({ apiKey })
  return new BaseLLMClient(cerebras(config.id) as any, "cerebras", config.id)
}
