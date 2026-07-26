import type { NexusConfig } from "@nexuscode/core"

export type ExplicitSettingReader = <T>(key: string) => T | undefined

const MODEL_PROVIDERS = new Set<string>([
  "anthropic",
  "openai",
  "google",
  "ollama",
  "openai-compatible",
  "azure",
  "bedrock",
  "groq",
  "mistral",
  "xai",
  "deepinfra",
  "cerebras",
  "cohere",
  "togetherai",
  "perplexity",
  "minimax",
])

const EMBEDDING_PROVIDERS = new Set<NonNullable<NexusConfig["embeddings"]>["provider"]>([
  "openai",
  "openai-compatible",
  "openrouter",
  "ollama",
  "google",
  "mistral",
  "bedrock",
  "local",
])

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function positiveInteger(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number > 0 ? Math.floor(number) : undefined
}

function configuredBoolean(
  read: ExplicitSettingReader,
  key: string,
): boolean | undefined {
  const value = read<boolean>(key)
  return typeof value === "boolean" ? value : undefined
}

/**
 * Merge only settings explicitly written at global/workspace/folder scope.
 *
 * VS Code contribution defaults are presentation defaults, not a second
 * configuration source: applying them would silently overwrite nexus.yaml on
 * every launch. Keeping this function independent of `vscode` makes the
 * precedence and validation rules executable in ordinary unit tests.
 */
export function applyExplicitConfigOverrides(
  config: NexusConfig,
  read: ExplicitSettingReader,
): void {
  const providerValue = nonEmptyString(read<string>("provider"))
  const baseUrl = nonEmptyString(read<string>("baseUrl"))
  if (providerValue === "openrouter") {
    config.model.provider = "openai-compatible"
    config.model.baseUrl = baseUrl ?? OPENROUTER_BASE_URL
  } else if (providerValue && MODEL_PROVIDERS.has(providerValue)) {
    config.model.provider = providerValue as NexusConfig["model"]["provider"]
    if (baseUrl) config.model.baseUrl = baseUrl
  } else if (baseUrl) {
    config.model.baseUrl = baseUrl
  }

  const model = nonEmptyString(read<string>("model"))
  if (model) config.model.id = model
  const temperature = finiteNumber(read<number>("temperature"))
  if (temperature !== undefined) {
    config.model.temperature = Math.max(0, Math.min(2, temperature))
  }
  const reasoningEffort = nonEmptyString(read<string>("reasoningEffort"))
  if (reasoningEffort) config.model.reasoningEffort = reasoningEffort
  const contextWindow = positiveInteger(read<number>("contextWindow"))
  if (contextWindow !== undefined) config.model.contextWindow = contextWindow

  const enableCheckpoints = configuredBoolean(read, "enableCheckpoints")
  if (enableCheckpoints !== undefined) config.checkpoint.enabled = enableCheckpoints
  const autoApproveRead = configuredBoolean(read, "autoApproveRead")
  if (autoApproveRead !== undefined) config.permissions.autoApproveRead = autoApproveRead
  const autoApproveWrite = configuredBoolean(read, "autoApproveWrite")
  if (autoApproveWrite !== undefined) config.permissions.autoApproveWrite = autoApproveWrite
  const autoApproveCommand = configuredBoolean(read, "autoApproveCommand")
  if (autoApproveCommand !== undefined) config.permissions.autoApproveCommand = autoApproveCommand
  const autoApproveMcp = configuredBoolean(read, "autoApproveMcp")
  if (autoApproveMcp !== undefined) config.permissions.autoApproveMcp = autoApproveMcp
  const autoApproveBrowser = configuredBoolean(read, "autoApproveBrowser")
  if (autoApproveBrowser !== undefined) config.permissions.autoApproveBrowser = autoApproveBrowser

  const enableIndexing = configuredBoolean(read, "enableIndexing")
  if (enableIndexing !== undefined) config.indexing.enabled = enableIndexing
  const enableVectorIndex = configuredBoolean(read, "enableVectorIndex")
  if (enableVectorIndex !== undefined) config.indexing.vector = enableVectorIndex
  const embeddingBatchSize = positiveInteger(read<number>("embeddingBatchSize"))
  if (embeddingBatchSize !== undefined) config.indexing.embeddingBatchSize = embeddingBatchSize
  const embeddingConcurrency = positiveInteger(read<number>("embeddingConcurrency"))
  if (embeddingConcurrency !== undefined) config.indexing.embeddingConcurrency = embeddingConcurrency

  const enableVectorDb = configuredBoolean(read, "enableVectorDb")
  const vectorDbUrl = nonEmptyString(read<string>("vectorDbUrl"))
  const vectorDbAutoStart = configuredBoolean(read, "vectorDbAutoStart")
  if (
    !config.vectorDb &&
    (enableVectorDb !== undefined || vectorDbUrl || vectorDbAutoStart !== undefined)
  ) {
    config.vectorDb = {
      enabled: false,
      url: "http://127.0.0.1:6333",
      collection: "nexus",
      autoStart: true,
    }
  }
  if (config.vectorDb && enableVectorDb !== undefined) config.vectorDb.enabled = enableVectorDb
  if (config.vectorDb && vectorDbUrl) config.vectorDb.url = vectorDbUrl
  if (config.vectorDb && vectorDbAutoStart !== undefined) config.vectorDb.autoStart = vectorDbAutoStart

  const embeddingProviderValue = nonEmptyString(read<string>("embeddingsProvider"))
  const embeddingProvider =
    embeddingProviderValue && EMBEDDING_PROVIDERS.has(
      embeddingProviderValue as NonNullable<NexusConfig["embeddings"]>["provider"],
    )
      ? embeddingProviderValue as NonNullable<NexusConfig["embeddings"]>["provider"]
      : undefined
  const embeddingModel = nonEmptyString(read<string>("embeddingsModel"))
  if (!config.embeddings && embeddingProvider && (embeddingModel || embeddingProvider === "local")) {
    config.embeddings = {
      provider: embeddingProvider,
      model: embeddingModel ?? "feature-hashing-v1",
    }
  }
  if (config.embeddings && embeddingProvider) config.embeddings.provider = embeddingProvider
  if (config.embeddings && embeddingModel) config.embeddings.model = embeddingModel
  const embeddingsBaseUrl = nonEmptyString(read<string>("embeddingsBaseUrl"))
  if (config.embeddings && embeddingsBaseUrl) config.embeddings.baseUrl = embeddingsBaseUrl
  const embeddingsDimensions = positiveInteger(read<number>("embeddingsDimensions"))
  if (config.embeddings && embeddingsDimensions !== undefined) {
    config.embeddings.dimensions = embeddingsDimensions
  }

  const toolClassifyThreshold = positiveInteger(read<number>("toolClassifyThreshold"))
  if (toolClassifyThreshold !== undefined) config.tools.classifyThreshold = toolClassifyThreshold
  const skillClassifyThreshold = positiveInteger(read<number>("skillClassifyThreshold"))
  if (skillClassifyThreshold !== undefined) config.skillClassifyThreshold = skillClassifyThreshold
}
