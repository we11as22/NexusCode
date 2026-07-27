import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"
import { resolveProviderCredential } from "./credential-identity.js"
import { createOpenRouterStreamNormalizingFetch } from "./openrouter-stream-normalize-fetch.js"

/** Fixes malformed SSE chunks from some OpenRouter models (e.g. x-ai) before AI SDK Zod parse. */
const openRouterFetch = createOpenRouterStreamNormalizingFetch()

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

  const normalizedBaseUrl = normalizeGatewayBaseUrl(config.baseUrl)
  const endpoint = classifyEndpoint(normalizedBaseUrl)
  const providerName = detectProviderFromUrl(normalizedBaseUrl)
  const credential = resolveProviderCredential({
    ...config,
    baseUrl: normalizedBaseUrl,
  })
  const apiKey = credential.apiKey ?? ""
  const model = endpoint === "kilo" && isKiloGatewayUrl(normalizedBaseUrl)
    ? createKiloGatewayModel(normalizedBaseUrl, apiKey, config.id)
    : endpoint === "openrouter"
      ? createOpenRouterModel(normalizedBaseUrl, apiKey, config.id)
      : createOpenAICompatible({
        name: providerName,
        apiKey,
        baseURL: normalizedBaseUrl,
        headers: endpoint === "kilo" ? DEFAULT_OPENROUTER_HEADERS : undefined,
      }).chatModel(config.id)

  return new BaseLLMClient(model as any, providerName, config.id)
}

/**
 * Ollama-specific client with correct base URL.
 */
export function createOllamaClient(config: ProviderConfig) {
  const baseUrl = normalizeOllamaBaseUrl(config.baseUrl)
  const credential = resolveProviderCredential({
    ...config,
    baseUrl,
  })
  const provider = createOpenAICompatible({
    name: "ollama",
    apiKey: credential.apiKey ?? "",
    baseURL: baseUrl,
  })
  const model = provider.chatModel(config.id)
  return new BaseLLMClient(model as any, "ollama", config.id)
}

function normalizeOllamaBaseUrl(baseUrl: string | undefined): string {
  const value = (baseUrl ?? "http://localhost:11434/v1").trim().replace(/\/+$/, "")
  return /\/v1$/i.test(value) ? value : `${value}/v1`
}

/**
 * Keep OpenAI-compatible services on the same LanguageModelV1 protocol as the
 * Nexus AI SDK v4 runtime. Several latest provider packages expose only v3
 * models, which compile behind `as any` but fail at the first stream call.
 */
export function createNamedOpenAICompatibleClient(
  config: ProviderConfig,
  providerName: string,
  defaultBaseUrl: string,
  apiKeyEnvNames: string[],
) {
  // `apiKeyEnvNames` is retained in the public helper signature for source
  // compatibility. The centralized resolver owns the destination allowlist.
  void apiKeyEnvNames
  const resolvedConfig = {
    ...config,
    baseUrl: config.baseUrl ?? defaultBaseUrl,
  }
  const apiKey = resolveProviderCredential(resolvedConfig).apiKey ?? ""
  const extraHeaders = config.extra?.["headers"]
  const headers =
    extraHeaders && typeof extraHeaders === "object" && !Array.isArray(extraHeaders)
      ? Object.fromEntries(
          Object.entries(extraHeaders)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : undefined
  const provider = createOpenAICompatible({
    name: providerName,
    apiKey,
    baseURL: resolvedConfig.baseUrl,
    headers,
  })
  return new BaseLLMClient(provider.chatModel(config.id) as any, providerName, config.id)
}

type EndpointKind = "kilo" | "openrouter" | "openai" | "local" | "custom"

function classifyEndpoint(baseUrl: string): EndpointKind {
  const hostname = endpointHostname(baseUrl)
  if (hostname === "api.kilo.ai") return "kilo"
  if (hostname === "openrouter.ai" || hostname === "api.openrouter.ai") return "openrouter"
  if (hostname === "api.openai.com") return "openai"
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "0.0.0.0"
  ) return "local"
  return "custom"
}

function endpointHostname(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return null
  }
}

function detectProviderFromUrl(baseUrl: string): string {
  const endpoint = classifyEndpoint(baseUrl)
  if (endpoint !== "custom") return endpoint
  const hostname = endpointHostname(baseUrl) ?? ""
  if (hostname.includes("groq")) return "groq"
  if (hostname.includes("together")) return "together"
  if (hostname.includes("mistral")) return "mistral"
  if (hostname.includes("fireworks")) return "fireworks"
  if (hostname.includes("cerebras")) return "cerebras"
  if (hostname.includes("perplexity")) return "perplexity"
  if (hostname.includes("deepseek")) return "deepseek"
  if (hostname === "api.x.ai" || hostname.includes("xai")) return "xai"
  return "openai-compatible"
}

function isKiloGatewayUrl(baseUrl: string): boolean {
  if (classifyEndpoint(baseUrl) !== "kilo") return false
  const url = baseUrl.toLowerCase()
  return url.includes("api.kilo.ai/api/openrouter") || url.includes("api.kilo.ai/api/organizations/")
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
  return classifyEndpoint(baseUrl) === "kilo" &&
    (isKiloGatewayUrl(baseUrl) || baseUrl.toLowerCase().includes("/api/gateway"))
    ? toKiloOpenRouterBase(baseUrl)
    : baseUrl
}

function createKiloGatewayModel(baseUrl: string, apiKey: string, modelId: string) {
  const provider = createOpenRouter({
    baseURL: toKiloOpenRouterBase(baseUrl),
    apiKey,
    headers: DEFAULT_OPENROUTER_HEADERS,
    fetch: openRouterFetch,
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
    fetch: openRouterFetch,
  }) as unknown as {
    languageModel?: (id: string) => unknown
    chatModel?: (id: string) => unknown
  }
  if (typeof provider.languageModel === "function") return provider.languageModel(modelId)
  if (typeof provider.chatModel === "function") return provider.chatModel(modelId)
  throw new Error("Failed to initialize OpenRouter model provider")
}
