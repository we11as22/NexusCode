import { createGoogleGenerativeAI } from "@ai-sdk/google"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createGoogleClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? ""
  const google = createGoogleGenerativeAI({
    apiKey,
    baseURL: config.baseUrl,
  })

  const model = google(config.id, {
    useSearchGrounding: false,
  })

  return new BaseLLMClient(model as any, "google", config.id)
}
