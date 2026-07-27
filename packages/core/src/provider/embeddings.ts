import { embedMany } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock"
import type { EmbeddingConfig } from "../types.js"
import type { EmbeddingClient } from "./types.js"
import {
  normalizeAwsRegion,
  resolveEmbeddingCredential,
} from "./credential-identity.js"

const OPENROUTER_BASE = "https://openrouter.ai/api/v1"

/**
 * Returns true if this embedding config requires an API key and it is missing.
 * When true, we should not create the embedding client (so nexus starts without vector; key can be added later).
 */
export function isEmbeddingApiKeyMissing(config: EmbeddingConfig): boolean {
  try {
    resolveEmbeddingCredential(normalizeEmbeddingAlias(config))
    return false
  } catch {
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
      return new OpenAICompatibleEmbeddingClient(normalizeEmbeddingAlias({
        ...config,
      }))
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
    const credential = resolveEmbeddingCredential(config)
    const openai = createOpenAI({
      apiKey: credential.apiKey ?? "",
      baseURL: config.baseUrl,
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
    const credential = resolveEmbeddingCredential(config)
    const openai = createOpenAI({
      apiKey: credential.apiKey ?? "",
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
    const baseUrl = normalizeOllamaBaseUrl(config.baseUrl)
    const credential = resolveEmbeddingCredential({
      ...config,
      baseUrl,
    })
    const openai = createOpenAI({
      apiKey: credential.apiKey ?? "",
      baseURL: baseUrl,
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
    const credential = resolveEmbeddingCredential(config)
    const google = createGoogleGenerativeAI({
      apiKey: credential.apiKey ?? "",
      baseURL: config.baseUrl,
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
    const credential = resolveEmbeddingCredential(config)
    const mistral = createOpenAI({
      apiKey: credential.apiKey ?? "",
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

function normalizeEmbeddingAlias(config: EmbeddingConfig): EmbeddingConfig {
  if (config.provider !== "openrouter") return config
  return {
    ...config,
    provider: "openai-compatible",
    baseUrl: config.baseUrl ?? OPENROUTER_BASE,
  }
}

class BedrockEmbeddingClient implements EmbeddingClient {
  private model: ReturnType<ReturnType<typeof createAmazonBedrock>["embedding"]>
  readonly dimensions: number

  constructor(config: EmbeddingConfig) {
    const region = normalizeAwsRegion(
      config.region ??
        process.env["AWS_REGION"] ??
        "us-east-1",
    )
    const bedrock = createAmazonBedrock({
      region,
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
