import { createDeepInfra } from "@ai-sdk/deepinfra"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createDeepInfraClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["DEEPINFRA_API_KEY"] ?? ""
  const deepinfra = createDeepInfra({ apiKey })
  return new BaseLLMClient(deepinfra(config.id), "deepinfra", config.id)
}
