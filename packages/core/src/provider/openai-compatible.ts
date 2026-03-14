import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

const DEFAULT_OPENROUTER_HEADERS = {
  "HTTP-Referer": "https://nexuscode.dev",
  "X-Title": "NexusCode",
}

/**
 * Generic OpenAI-compatible provider.
 * Works with: LM Studio, Ollama, vLLM, Together, Groq, Mistral, Cerebras, xAI, Deepseek,
 * Anyscale, Fireworks, Perplexity, and any other OpenAI-compatible API.
 */
export function createOpenAICompatibleClient(config: ProviderConfig) {
  if (!config.baseUrl) {
    throw new Error("openai-compatible provider requires baseUrl")
  }

  const apiKey =
    config.apiKey ??
    process.env["OPENAI_API_KEY"] ??
    process.env["OPENROUTER_API_KEY"] ??
    process.env["KILO_API_KEY"] ??
    process.env["NEXUS_API_KEY"] ??
    "dummy"
  if (apiKey === "dummy" && !isApiKeyOptionalBaseUrl(config.baseUrl)) {
    throw new Error(
      "Missing API key for openai-compatible provider. Set model.apiKey or OPENAI_API_KEY/OPENROUTER_API_KEY/NEXUS_API_KEY."
    )
  }
  // Detect provider name from baseUrl for better structured output support
  const normalizedBaseUrl = normalizeGatewayBaseUrl(config.baseUrl)
  const providerName = detectProviderFromUrl(normalizedBaseUrl)
  const model = isKiloGatewayUrl(normalizedBaseUrl)
    ? createKiloGatewayModel(normalizedBaseUrl, apiKey, config.id)
    : isOpenRouterUrl(config.baseUrl)
      ? createOpenRouterModel(normalizedBaseUrl, apiKey, config.id)
      : createOpenAICompatible({
        name: providerName,
        apiKey,
        baseURL: normalizedBaseUrl,
        headers: needsOpenRouterHeaders(normalizedBaseUrl) ? DEFAULT_OPENROUTER_HEADERS : undefined,
      }).chatModel(config.id)

  return new BaseLLMClient(model as any, providerName, config.id)
}

/**
 * Ollama-specific client with correct base URL.
 */
export function createOllamaClient(config: ProviderConfig) {
  const provider = createOpenAICompatible({
    name: "ollama",
    apiKey: "ollama",
    baseURL: config.baseUrl ?? "http://localhost:11434/v1",
  })
  const model = provider.chatModel(config.id)
  return new BaseLLMClient(model as any, "ollama", config.id)
}

function detectProviderFromUrl(baseUrl: string): string {
  const url = baseUrl.toLowerCase()
  if (url.includes("api.kilo.ai")) return "kilo"
  if (url.includes("openrouter.ai")) return "openrouter"
  if (url.includes("groq")) return "groq"
  if (url.includes("together")) return "together"
  if (url.includes("mistral")) return "mistral"
  if (url.includes("fireworks")) return "fireworks"
  if (url.includes("cerebras")) return "cerebras"
  if (url.includes("perplexity")) return "perplexity"
  if (url.includes("deepseek")) return "deepseek"
  if (url.includes("x.ai") || url.includes("xai")) return "xai"
  if (url.includes("localhost") || url.includes("127.0.0.1")) return "local"
  return "openai-compatible"
}

function isApiKeyOptionalBaseUrl(baseUrl: string): boolean {
  const url = baseUrl.toLowerCase()
  return (
    url.includes("localhost") ||
    url.includes("127.0.0.1") ||
    url.includes("api.kilo.ai/api/")
  )
}

function isKiloGatewayUrl(baseUrl: string): boolean {
  const url = baseUrl.toLowerCase()
  return url.includes("api.kilo.ai/api/openrouter") || url.includes("api.kilo.ai/api/organizations/")
}

function isOpenRouterUrl(baseUrl: string): boolean {
  return baseUrl.toLowerCase().includes("openrouter.ai")
}

function toKiloOpenRouterBase(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  const lower = trimmed.toLowerCase()
  if (lower.includes("/api/gateway")) {
    const withoutGateway = trimmed.replace(/\/api\/gateway\/?$/i, "/api/openrouter")
    return withoutGateway.endsWith("/") ? withoutGateway : `${withoutGateway}/`
  }
  if (lower.includes("/openrouter")) return trimmed.endsWith("/") ? trimmed : `${trimmed}/`
  if (lower.includes("/api/organizations/")) return trimmed.endsWith("/") ? trimmed : `${trimmed}/`
  if (trimmed.endsWith("/api")) return `${trimmed}/openrouter/`
  return trimmed.endsWith("/") ? `${trimmed}api/openrouter/` : `${trimmed}/api/openrouter/`
}

function normalizeGatewayBaseUrl(baseUrl: string): string {
  return isKiloGatewayUrl(baseUrl) || baseUrl.toLowerCase().includes("api.kilo.ai/api/gateway")
    ? toKiloOpenRouterBase(baseUrl)
    : baseUrl
}

function needsOpenRouterHeaders(baseUrl: string): boolean {
  const url = baseUrl.toLowerCase()
  return url.includes("openrouter.ai") || url.includes("api.kilo.ai/api/")
}

function createKiloGatewayModel(baseUrl: string, apiKey: string, modelId: string) {
  const provider = createOpenRouter({
    baseURL: toKiloOpenRouterBase(baseUrl),
    apiKey,
    headers: DEFAULT_OPENROUTER_HEADERS,
  }) as unknown as {
    languageModel?: (id: string) => unknown
    chatModel?: (id: string) => unknown
  }
  if (typeof provider.languageModel === "function") return provider.languageModel(modelId)
  if (typeof provider.chatModel === "function") return provider.chatModel(modelId)
  throw new Error("Failed to initialize Kilo Gateway model provider")
}

function createOpenRouterModel(baseUrl: string, apiKey: string, modelId: string) {
  const provider = createOpenRouter({
    baseURL: baseUrl,
    apiKey,
    headers: DEFAULT_OPENROUTER_HEADERS,
  }) as unknown as {
    languageModel?: (id: string) => unknown
    chatModel?: (id: string) => unknown
  }
  if (typeof provider.languageModel === "function") return provider.languageModel(modelId)
  if (typeof provider.chatModel === "function") return provider.chatModel(modelId)
  throw new Error("Failed to initialize OpenRouter model provider")
}
