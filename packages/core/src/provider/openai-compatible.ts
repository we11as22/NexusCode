import { createOpenAI } from "@ai-sdk/openai"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"

/**
 * Generic OpenAI-compatible provider.
 * Works with: LM Studio, Ollama, vLLM, Together, Groq, Mistral, Cerebras, xAI, Deepseek,
 * Anyscale, Fireworks, Perplexity, and any other OpenAI-compatible API.
 */
export function createOpenAICompatibleClient(config: ProviderConfig) {
  if (!config.baseUrl) {
    throw new Error("openai-compatible provider requires baseUrl")
  }

  const apiKey = config.apiKey ?? process.env["NEXUS_API_KEY"] ?? "dummy"
  const openai = createOpenAI({
    apiKey,
    baseURL: config.baseUrl,
    compatibility: "compatible",
  })

  const model = openai.chat(config.id)

  // Detect provider name from baseUrl for better structured output support
  const providerName = detectProviderFromUrl(config.baseUrl)

  return new BaseLLMClient(model as any, providerName, config.id)
}

/**
 * Ollama-specific client with correct base URL.
 */
export function createOllamaClient(config: ProviderConfig) {
  const openai = createOpenAI({
    apiKey: "ollama",
    baseURL: config.baseUrl ?? "http://localhost:11434/v1",
    compatibility: "compatible",
  })

  const model = openai.chat(config.id)
  return new BaseLLMClient(model as any, "ollama", config.id)
}

function detectProviderFromUrl(baseUrl: string): string {
  const url = baseUrl.toLowerCase()
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
