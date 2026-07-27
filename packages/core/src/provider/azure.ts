import { createAzure } from "@ai-sdk/azure"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"
import {
  normalizeAzureResourceName,
  resolveProviderCredential,
} from "./credential-identity.js"

export function createAzureClient(config: ProviderConfig) {
  const apiKey = resolveProviderCredential(config).apiKey ?? ""
  const resourceName = config.baseUrl
    ? undefined
    : normalizeAzureResourceName(config.resourceName)
  const azure = createAzure({
    apiKey,
    baseURL: config.baseUrl,
    resourceName,
    apiVersion: config.apiVersion ?? "2025-01-01-preview",
  })
  const model = azure(config.deploymentId ?? config.id)
  return new BaseLLMClient(model as any, "azure", config.id)
}
