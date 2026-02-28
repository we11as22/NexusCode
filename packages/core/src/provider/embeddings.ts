import { embedMany } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import type { EmbeddingConfig } from "../types.js"
import type { EmbeddingClient } from "./types.js"

export function createEmbeddingClient(config: EmbeddingConfig): EmbeddingClient {
  switch (config.provider) {
    case "openai":
      return new OpenAIEmbeddingClient(config)
    case "openai-compatible":
      return new OpenAICompatibleEmbeddingClient(config)
    case "ollama":
      return new OllamaEmbeddingClient(config)
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
    const openai = createOpenAI({
      apiKey: config.apiKey
        ?? process.env["OPENAI_API_KEY"]
        ?? process.env["OPENROUTER_API_KEY"]
        ?? process.env["NEXUS_API_KEY"]
        ?? "dummy",
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
