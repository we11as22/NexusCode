import { createGroq } from "@ai-sdk/groq"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createGroqClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["GROQ_API_KEY"] ?? ""
  const groq = createGroq({ apiKey })
  return new BaseLLMClient(groq(config.id), "groq", config.id)
}
