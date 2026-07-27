import { createGoogleGenerativeAI } from "@ai-sdk/google"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"
import { resolveProviderCredential } from "./credential-identity.js"

export function createGoogleClient(config: ProviderConfig) {
  const apiKey = resolveProviderCredential(config).apiKey ?? ""
  const google = createGoogleGenerativeAI({
    apiKey,
    baseURL: config.baseUrl,
  })

  const model = google(config.id, {
    useSearchGrounding: false,
  })

  return new BaseLLMClient(model as any, "google", config.id)
}
