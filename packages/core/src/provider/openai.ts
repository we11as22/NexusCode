import { createOpenAI } from "@ai-sdk/openai"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"
import { resolveProviderCredential } from "./credential-identity.js"

export function createOpenAIClient(config: ProviderConfig) {
  const apiKey = resolveProviderCredential(config).apiKey ?? ""
  const openai = createOpenAI({
    apiKey,
    baseURL: config.baseUrl,
  })

  // Use responses API for newer models, chat.completions for older
  const isResponsesModel = config.id.startsWith("o") || config.id.startsWith("gpt-5") || config.id.includes("gpt-4o")
  const model = isResponsesModel
    ? openai.responses(config.id)
    : openai.chat(config.id)

  return new BaseLLMClient(model as any, "openai", config.id)
}
