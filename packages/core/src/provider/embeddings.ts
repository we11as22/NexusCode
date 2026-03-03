import { embedMany } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import type { EmbeddingConfig } from "../types.js"
import type { EmbeddingClient } from "./types.js"

const OPENROUTER_BASE = "https://openrouter.ai/api/v1"

/**
 * Returns true if this embedding config requires an API key and it is missing.
 * When true, we should not create the embedding client (so nexus starts without vector; key can be added later).
 */
export function isEmbeddingApiKeyMissing(config: EmbeddingConfig): boolean {
  const key =
    config.apiKey
    ?? process.env["OPENAI_API_KEY"]
    ?? process.env["OPENROUTER_API_KEY"]
    ?? process.env["NEXUS_API_KEY"]
    ?? ""
  if (typeof key === "string" && key.trim() !== "") return false
  switch (config.provider) {
    case "ollama":
    case "local":
      return false
    case "openai-compatible":
      return !isLocalBaseUrl(config.baseUrl)
    case "openrouter":
      return true
    case "openai":
    case "google":
    case "mistral":
    case "bedrock":
      return true
    default:
      return true
  }
}

export function createEmbeddingClient(config: EmbeddingConfig): EmbeddingClient {
  switch (config.provider) {
    case "openai":
      return new OpenAIEmbeddingClient(config)
    case "openai-compatible":
      return new OpenAICompatibleEmbeddingClient(config)
    case "openrouter":
      return new OpenAICompatibleEmbeddingClient({
        ...config,
        provider: "openai-compatible",
        baseUrl: config.baseUrl ?? OPENROUTER_BASE,
        apiKey: config.apiKey ?? process.env["OPENROUTER_API_KEY"] ?? config.apiKey,
      })
    case "ollama":
      return new OllamaEmbeddingClient(config)
    case "google":
      return new GoogleEmbeddingClient(config)
    case "mistral":
      return new MistralEmbeddingClient(config)
    case "bedrock":
      return new BedrockEmbeddingClient(config)
    case "local":
      return new LocalEmbeddingClient(config)
    default:
      throw new Error(`Unknown embedding provider: ${(config as EmbeddingConfig).provider}`)
  }
}

class OpenAIEmbeddingClient implements EmbeddingClient {
  private model: ReturnType<ReturnType<typeof createOpenAI>["embedding"]>
  readonly dimensions: number

  constructor(config: EmbeddingConfig) {
    const openai = createOpenAI({
      apiKey: config.apiKey
        ?? process.env["OPENAI_API_KEY"]
        ?? process.env["NEXUS_API_KEY"]
        ?? "",
    })
    this.model = openai.embedding(config.model)
    this.dimensions = config.dimensions ?? 1536
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await embedMany({ model: this.model, values: texts })
    return result.embeddings
  }
}

class OpenAICompatibleEmbeddingClient implements EmbeddingClient {
  private model: ReturnType<ReturnType<typeof createOpenAI>["embedding"]>
  readonly dimensions: number

  constructor(config: EmbeddingConfig) {
    const apiKey = config.apiKey
      ?? process.env["OPENAI_API_KEY"]
      ?? process.env["OPENROUTER_API_KEY"]
      ?? process.env["NEXUS_API_KEY"]
      ?? "dummy"
    if (apiKey === "dummy" && !isLocalBaseUrl(config.baseUrl)) {
      throw new Error(
        "Missing API key for openai-compatible embeddings. Set embeddings.apiKey or OPENROUTER_API_KEY/NEXUS_API_KEY."
      )
    }
    const openai = createOpenAI({
      apiKey,
      baseURL: config.baseUrl,
      compatibility: "compatible",
    })
    this.model = openai.embedding(config.model)
    this.dimensions = config.dimensions ?? 1536
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await embedMany({ model: this.model, values: texts })
    return result.embeddings
  }
}

class OllamaEmbeddingClient implements EmbeddingClient {
  private model: ReturnType<ReturnType<typeof createOpenAI>["embedding"]>
  readonly dimensions: number

  constructor(config: EmbeddingConfig) {
    const openai = createOpenAI({
      apiKey: "ollama",
      baseURL: config.baseUrl ?? "http://localhost:11434/v1",
      compatibility: "compatible",
    })
    this.model = openai.embedding(config.model)
    this.dimensions = config.dimensions ?? 384
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await embedMany({ model: this.model, values: texts })
    return result.embeddings
  }
}

class GoogleEmbeddingClient implements EmbeddingClient {
  private model: ReturnType<ReturnType<typeof createGoogleGenerativeAI>["embedding"]>
  readonly dimensions: number

  constructor(config: EmbeddingConfig) {
    const google = createGoogleGenerativeAI({
      apiKey: config.apiKey ?? process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "",
    })
    this.model = google.embedding(config.model)
    this.dimensions = config.dimensions ?? 768
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await embedMany({ model: this.model, values: texts })
    return result.embeddings
  }
}

class MistralEmbeddingClient implements EmbeddingClient {
  private model: ReturnType<ReturnType<typeof createMistral>["embedding"]>
  readonly dimensions: number

  constructor(config: EmbeddingConfig) {
    const mistral = createMistral({
      apiKey: config.apiKey ?? process.env["MISTRAL_API_KEY"] ?? "",
    })
    this.model = mistral.embedding(config.model)
    this.dimensions = config.dimensions ?? 1024
  }

  async embed(texts: string[]): Promise<number[][]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await embedMany({ model: this.model as any, values: texts })
    return result.embeddings
  }
}

class BedrockEmbeddingClient implements EmbeddingClient {
  private model: ReturnType<ReturnType<typeof createAmazonBedrock>["embedding"]>
  readonly dimensions: number

  constructor(config: EmbeddingConfig) {
    const bedrock = createAmazonBedrock({
      region: config.region ?? process.env["AWS_REGION"] ?? "us-east-1",
    })
    this.model = bedrock.embedding(config.model)
    this.dimensions = config.dimensions ?? 1024
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await embedMany({ model: this.model, values: texts })
    return result.embeddings
  }
}

/**
 * Local embedding using @xenova/transformers (offline, CPU-based).
 * Lazy-loaded to avoid import if not used.
 */
class LocalEmbeddingClient implements EmbeddingClient {
  readonly dimensions: number
  private modelName: string
  private pipeline: ((texts: string[], opts?: Record<string, unknown>) => Promise<{ data: Float32Array[] }>) | null = null

  constructor(config: EmbeddingConfig) {
    this.modelName = config.model ?? "Xenova/all-MiniLM-L6-v2"
    this.dimensions = config.dimensions ?? 384
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.pipeline) {
      // Lazy load @xenova/transformers
      const { pipeline } = await import("@xenova/transformers" as string as any) as any
      this.pipeline = await pipeline("feature-extraction", this.modelName)
    }
    const results: number[][] = []
    for (const text of texts) {
      const output = await this.pipeline!([text], { pooling: "mean", normalize: true })
      results.push(Array.from(output.data[0]))
    }
    return results
  }
}

function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  const url = baseUrl.toLowerCase()
  return url.includes("localhost") || url.includes("127.0.0.1")
}
