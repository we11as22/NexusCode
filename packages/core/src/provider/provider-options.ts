import type { ProviderConfig } from "../types.js"

type NormalizedReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "max"
  | "xhigh"

type ProviderOptionsRecord = Record<string, unknown>

const OPENAI_LIKE_PROVIDER_NAMES = new Set([
  "openai",
  "openai-compatible",
  "local",
  "kilo",
  "groq",
  "together",
  "mistral",
  "fireworks",
  "cerebras",
  "perplexity",
  "deepseek",
  "xai",
  "azure",
  "ollama",
])

export function buildReasoningProviderOptions(
  model: Pick<ProviderConfig, "provider" | "id" | "reasoningEffort">,
  runtimeProviderName: string
): ProviderOptionsRecord | undefined {
  const reasoning = buildSingleReasoningProviderOptions(model, runtimeProviderName)
  return mergeProviderOptionBlocks(
    buildProviderBaseOptions(model, runtimeProviderName),
    reasoning
  )
}

export function getDefaultTemperature(
  model: Pick<ProviderConfig, "id">
): number | undefined {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 0.55
  if (id.includes("claude")) return undefined
  if (id.includes("gemini")) return 1.0
  if (id.includes("glm-4.6") || id.includes("glm-4.7")) return 1.0
  if (id.includes("minimax-m2")) return 1.0
  if (id.includes("kimi-k2")) {
    if (["thinking", "k2.", "k2p", "k2-5"].some((s) => id.includes(s))) {
      return 1.0
    }
    return 0.6
  }
  return undefined
}

export function getDefaultTopP(
  model: Pick<ProviderConfig, "id">
): number | undefined {
  const id = model.id.toLowerCase()
  if (id.includes("qwen")) return 1
  if (["minimax-m2", "gemini", "kimi-k2.5", "kimi-k2p5", "kimi-k2-5"].some((s) => id.includes(s))) {
    return 0.95
  }
  return undefined
}

export function getDefaultTopK(
  model: Pick<ProviderConfig, "id">
): number | undefined {
  const id = model.id.toLowerCase()
  if (id.includes("minimax-m2")) {
    if (["m2.", "m25", "m21"].some((s) => id.includes(s))) return 40
    return 20
  }
  if (id.includes("gemini")) return 64
  return undefined
}

function buildSingleReasoningProviderOptions(
  model: Pick<ProviderConfig, "provider" | "id" | "reasoningEffort">,
  runtimeProviderName: string
): ProviderOptionsRecord | undefined {
  const runtime = runtimeProviderName.toLowerCase()
  const configured = model.provider.toLowerCase()
  const modelIdLower = model.id.toLowerCase()
  if (shouldDisableReasoningOptionsForGateway(runtime, configured, modelIdLower)) {
    return undefined
  }
  const effort = normalizeEffortForModel(
    resolveReasoningEffort(model.reasoningEffort, model.id),
    runtime,
    configured,
    modelIdLower
  )
  if (!effort) return undefined

  if (runtime === "anthropic" || configured === "anthropic") {
    if (effort === "none") return undefined
    return {
      anthropic: {
        thinking: {
          type: "enabled" as const,
          budgetTokens: anthropicBudgetFromEffort(effort),
        },
      },
    }
  }

  if (runtime === "google" || configured === "google") {
    if (effort === "none") {
      return {
        google: {
          thinkingConfig: {
            includeThoughts: false,
          },
        },
      }
    }
    const level = effortToLevel(effort)
    return {
      google: {
        thinkingConfig: level
          ? {
              includeThoughts: true,
              thinkingLevel: level,
            }
          : {
              includeThoughts: true,
              thinkingBudget: googleBudgetFromEffort(effort),
            },
      },
    }
  }

  if (runtime === "bedrock" || configured === "bedrock") {
    if (effort === "none") return undefined
    return {
      bedrock: {
        reasoningConfig: {
          type: "enabled" as const,
          budgetTokens: anthropicBudgetFromEffort(effort),
        },
      },
    }
  }

  if (!OPENAI_LIKE_PROVIDER_NAMES.has(runtime) && !OPENAI_LIKE_PROVIDER_NAMES.has(configured)) {
    return undefined
  }

  const effortValue = effort === "none" ? "none" : effort
  return {
    [getPrimaryOpenAIProviderNamespace(runtimeProviderName)]: {
      reasoningEffort: effortValue,
      ...(effort === "none"
        ? {}
        : {
            reasoning: {
              effort: effortValue,
              summary: "auto",
            },
          }),
    },
  }
}

function buildProviderBaseOptions(
  model: Pick<ProviderConfig, "provider" | "id" | "reasoningEffort">,
  runtimeProviderName: string
): ProviderOptionsRecord | undefined {
  const runtime = runtimeProviderName.toLowerCase()
  const configured = model.provider.toLowerCase()
  const modelIdLower = model.id.toLowerCase()

  if (runtime.includes("openrouter") || runtime.includes("kilo") || configured.includes("openrouter")) {
    const providerKey = getPrimaryOpenAIProviderNamespace(runtimeProviderName)
    return {
      [providerKey]: {
        usage: { include: true },
        ...(modelIdLower.includes("gemini-3") ? { reasoning: { effort: "high" } } : {}),
      },
    }
  }

  if (runtime === "google" || configured === "google") {
    return {
      google: {
        thinkingConfig: {
          includeThoughts: true,
        },
      },
    }
  }

  return undefined
}

function mergeProviderOptionBlocks(
  ...parts: Array<ProviderOptionsRecord | undefined>
): ProviderOptionsRecord | undefined {
  const merged: ProviderOptionsRecord = {}
  for (const part of parts) {
    if (!part) continue
    for (const [key, value] of Object.entries(part)) {
      const existing = merged[key]
      if (isPlainRecord(existing) && isPlainRecord(value)) {
        merged[key] = { ...existing, ...value }
      } else {
        merged[key] = value
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function shouldDisableReasoningOptionsForGateway(runtime: string, configured: string, modelIdLower: string): boolean {
  const isOpenRouterLike =
    runtime.includes("openrouter") ||
    configured.includes("openrouter")

  if (!isOpenRouterLike) return false

  // Kilo/OpenRouter compatibility: only send explicit reasoning controls to families
  // known to accept them reliably through OpenRouter-style routing.
  const supportsOpenRouterReasoningControls =
    modelIdLower.includes("gpt") ||
    modelIdLower.includes("claude") ||
    modelIdLower.includes("gemini-3")

  return !supportsOpenRouterReasoningControls
}

function dedupeCandidates(candidates: Array<ProviderOptionsRecord | undefined>): Array<ProviderOptionsRecord | undefined> {
  const result: Array<ProviderOptionsRecord | undefined> = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = candidate == null ? "__none__" : stableStringify(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

function getOpenAIProviderNamespaces(runtimeProviderName: string): string[] {
  const out = new Set<string>()
  const runtime = runtimeProviderName.trim()
  if (runtime) out.add(runtime)
  out.add("openai")
  out.add("openaiCompatible")
  out.add("openrouter")
  out.add("gateway")
  return [...out]
}

function getPrimaryOpenAIProviderNamespace(runtimeProviderName: string): string {
  return getOpenAIProviderNamespaces(runtimeProviderName)[0] ?? "openai"
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectDeep(value))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
}

function sortObjectDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectDeep)
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(obj)
        .sort()
        .map((key) => [key, sortObjectDeep(obj[key])])
    )
  }
  return value
}

function resolveReasoningEffort(raw: string | undefined, modelId: string): NormalizedReasoningEffort | undefined {
  const normalized = normalizeEffort(raw)
  if (normalized) {
    return normalized === "disable" ? undefined : normalized
  }

  // Auto-enable for clearly reasoning-capable model families.
  return looksReasoningModel(modelId) ? "medium" : undefined
}

function normalizeEffortForModel(
  effort: NormalizedReasoningEffort | undefined,
  runtime: string,
  configured: string,
  modelIdLower: string
): NormalizedReasoningEffort | undefined {
  if (!effort) return undefined
  const supported = supportedEffortsFor(runtime, configured, modelIdLower)
  if (supported.has(effort)) return effort
  // Prefer medium fallback when the model is reasoning-capable but does not support requested variant.
  if (supported.has("medium")) return "medium"
  if (supported.has("high")) return "high"
  if (supported.has("low")) return "low"
  if (supported.has("minimal")) return "minimal"
  if (supported.has("none")) return "none"
  return undefined
}

function supportedEffortsFor(runtime: string, configured: string, modelIdLower: string): Set<NormalizedReasoningEffort> {
  const base = new Set<NormalizedReasoningEffort>(["none", "minimal", "low", "medium", "high", "max", "xhigh"])
  const provider = `${runtime}/${configured}`
  if (provider.includes("anthropic")) return new Set<NormalizedReasoningEffort>(["none", "low", "medium", "high", "max"])
  if (provider.includes("google")) return new Set<NormalizedReasoningEffort>(["none", "minimal", "low", "medium", "high", "max"])
  if (provider.includes("bedrock")) return new Set<NormalizedReasoningEffort>(["none", "low", "medium", "high", "max"])
  if (modelIdLower.includes("grok-3-mini")) return new Set<NormalizedReasoningEffort>(["low", "high"])
  if (
    modelIdLower.includes("deepseek") ||
    modelIdLower.includes("minimax") ||
    modelIdLower.includes("glm") ||
    modelIdLower.includes("mistral") ||
    modelIdLower.includes("kimi") ||
    modelIdLower.includes("k2p5") ||
    modelIdLower.includes("qwen") ||
    modelIdLower.includes("qwq")
  ) {
    return new Set<NormalizedReasoningEffort>(["low", "medium", "high"])
  }
  if (modelIdLower.includes("gpt-5") || modelIdLower.startsWith("o1") || modelIdLower.startsWith("o3") || modelIdLower.startsWith("o4")) {
    return base
  }
  return base
}

function normalizeEffort(raw: string | undefined): NormalizedReasoningEffort | "disable" | undefined {
  if (!raw) return undefined
  const val = raw.trim().toLowerCase()
  if (!val || val === "auto" || val === "default") return undefined
  if (val === "disable" || val === "off" || val === "false") return "disable"
  if (val === "none") return "none"
  if (val === "minimal" || val === "min") return "minimal"
  if (val === "low") return "low"
  if (val === "medium" || val === "med") return "medium"
  if (val === "high") return "high"
  if (val === "max") return "max"
  if (val === "xhigh" || val === "very_high") return "xhigh"
  return undefined
}

function looksReasoningModel(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return (
    id.startsWith("o1") ||
    id.startsWith("o3") ||
    id.startsWith("o4") ||
    id.includes("gpt-5") ||
    id.includes("reasoner") ||
    id.includes("reasoning") ||
    id.includes("thinking") ||
    id.includes("deepseek-r1") ||
    id.includes("qwen3") ||
    id.includes("qwq") ||
    // Specific Claude models that support extended thinking
    id.includes("claude-3-7") ||
    id.includes("claude-sonnet-4") ||
    id.includes("claude-opus-4") ||
    // Specific Gemini models that support thinking
    id.includes("gemini-2.0-flash-thinking") ||
    id.includes("gemini-2.5") ||
    id.includes("grok-3-mini") ||
    id.includes("minimax-m2") ||
    id.includes("kimi-k2")
  )
}

function anthropicBudgetFromEffort(effort: NormalizedReasoningEffort): number {
  switch (effort) {
    case "minimal":
      return 2_048
    case "low":
      return 4_096
    case "medium":
      return 8_000
    case "high":
      return 16_000
    case "max":
    case "xhigh":
      return 31_999
    case "none":
      return 1_024
  }
}

function googleBudgetFromEffort(effort: NormalizedReasoningEffort): number {
  switch (effort) {
    case "minimal":
      return 1_024
    case "low":
      return 4_096
    case "medium":
      return 8_192
    case "high":
      return 16_384
    case "max":
    case "xhigh":
      return 24_576
    case "none":
      return 0
  }
}

function effortToLevel(effort: NormalizedReasoningEffort): "low" | "medium" | "high" | undefined {
  switch (effort) {
    case "minimal":
    case "low":
      return "low"
    case "medium":
      return "medium"
    case "high":
    case "max":
    case "xhigh":
      return "high"
    default:
      return undefined
  }
}
