import { embedMany } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import type { EmbeddingConfig } from "../types.js"
import type { EmbeddingClient } from "./types.js"

const OPENROUTER_BASE = "https://openrouter.ai/api/v1"

/**
 * Returns true if this embedding config requires an API key and it is missing.
 * When true, we should not create the embedding client (so nexus starts without vector; key can be added later).
 */
export function isEmbeddingApiKeyMissing(config: EmbeddingConfig): boolean {
  const hasKey = (...values: Array<string | undefined>) =>
    values.some((value) => typeof value === "string" && value.trim() !== "")
  switch (config.provider) {
    case "ollama":
    case "local":
    case "bedrock":
      return false
    case "openai-compatible":
      return !isLocalBaseUrl(config.baseUrl) && !hasKey(
        config.apiKey,
        process.env["OPENAI_API_KEY"],
        process.env["OPENROUTER_API_KEY"],
        process.env["NEXUS_API_KEY"],
      )
    case "openrouter":
      return !hasKey(
        config.apiKey,
        process.env["OPENROUTER_API_KEY"],
        process.env["NEXUS_API_KEY"],
      )
    case "openai":
      return !hasKey(
        config.apiKey,
        process.env["OPENAI_API_KEY"],
        process.env["NEXUS_API_KEY"],
      )
    case "google":
      return !hasKey(
        config.apiKey,
        process.env["GOOGLE_GENERATIVE_AI_API_KEY"],
        process.env["GEMINI_API_KEY"],
        process.env["NEXUS_API_KEY"],
      )
    case "mistral":
      return !hasKey(
        config.apiKey,
        process.env["MISTRAL_API_KEY"],
        process.env["NEXUS_API_KEY"],
      )
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
      baseURL: normalizeOllamaBaseUrl(config.baseUrl),
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

function normalizeOllamaBaseUrl(baseUrl: string | undefined): string {
  const value = (baseUrl ?? "http://localhost:11434/v1").trim().replace(/\/+$/, "")
  return /\/v1$/i.test(value) ? value : `${value}/v1`
}

class GoogleEmbeddingClient implements EmbeddingClient {
  private model: ReturnType<ReturnType<typeof createGoogleGenerativeAI>["embedding"]>
  readonly dimensions: number

  constructor(config: EmbeddingConfig) {
    const google = createGoogleGenerativeAI({
      apiKey:
        config.apiKey ??
        process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ??
        process.env["GEMINI_API_KEY"] ??
        process.env["NEXUS_API_KEY"] ??
        "",
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
  private model: ReturnType<ReturnType<typeof createOpenAI>["embedding"]>
  readonly dimensions: number

  constructor(config: EmbeddingConfig) {
    const mistral = createOpenAI({
      apiKey:
        config.apiKey ??
        process.env["MISTRAL_API_KEY"] ??
        process.env["NEXUS_API_KEY"] ??
        "",
      baseURL: config.baseUrl ?? "https://api.mistral.ai/v1",
      compatibility: "compatible",
    })
    this.model = mistral.embedding(config.model)
    this.dimensions = config.dimensions ?? 1024
  }

  async embed(texts: string[]): Promise<number[][]> {
    const result = await embedMany({ model: this.model, values: texts })
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
 * Dependency-free offline feature-hashing embeddings.
 *
 * This is intentionally lexical rather than pretending to ship a neural model:
 * it gives Nexus a portable, deterministic local index in CLI, server and VSIX
 * builds without downloading model weights or relying on an undeclared native
 * dependency. Users who want neural semantic search can select Ollama or a
 * hosted embedding provider.
 */
class LocalEmbeddingClient implements EmbeddingClient {
  readonly dimensions: number

  constructor(config: EmbeddingConfig) {
    this.dimensions = Math.max(1, Math.floor(config.dimensions ?? 384))
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => featureHashEmbedding(text, this.dimensions))
  }
}

function stableHash(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function localEmbeddingFeatures(text: string): string[] {
  const expanded = text
    .normalize("NFKC")
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .toLocaleLowerCase("en-US")
  const words = expanded.match(/[\p{L}\p{N}_$]+/gu) ?? []
  const tokens = words.flatMap((word) => {
    const parts = word.split(/[_$]+/).filter(Boolean)
    return parts.length > 1 ? [word, ...parts] : [word]
  })
  const features: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    features.push(`word:${token}`)
    const padded = `^${token}$`
    if (padded.length <= 3) {
      features.push(`char:${padded}`)
    } else {
      for (let offset = 0; offset <= padded.length - 3; offset += 1) {
        features.push(`char:${padded.slice(offset, offset + 3)}`)
      }
    }
    const next = tokens[index + 1]
    if (next) features.push(`pair:${token}\u0001${next}`)
  }
  return features
}

function featureHashEmbedding(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0)
  const counts = new Map<string, number>()
  for (const feature of localEmbeddingFeatures(text)) {
    counts.set(feature, (counts.get(feature) ?? 0) + 1)
  }
  for (const [feature, count] of counts) {
    const bucket = stableHash(feature, 0x811c9dc5) % dimensions
    const sign = (stableHash(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1
    vector[bucket] = (vector[bucket] ?? 0) + sign * (1 + Math.log(count))
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  if (norm === 0) return vector
  return vector.map((value) => value / norm)
}

function isLocalBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    const parsed = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)
        ? baseUrl
        : `http://${baseUrl}`,
    )
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0"
    )
  } catch {
    return false
  }
}
