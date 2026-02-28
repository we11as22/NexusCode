import { createTogetherAI } from "@ai-sdk/togetherai"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createTogetherAIClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["TOGETHER_AI_API_KEY"] ?? process.env["TOGETHERAI_API_KEY"] ?? ""
  const together = createTogetherAI({ apiKey })
  return new BaseLLMClient(together(config.id) as any, "togetherai", config.id)
}
