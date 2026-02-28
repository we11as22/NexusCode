import { createAzure } from "@ai-sdk/azure"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

export function createAzureClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["AZURE_API_KEY"] ?? ""
  const azure = createAzure({
    apiKey,
    resourceName: config.resourceName ?? "",
    apiVersion: config.apiVersion ?? "2025-01-01-preview",
  })
  const model = azure(config.deploymentId ?? config.id)
  return new BaseLLMClient(model as any, "azure", config.id)
}
