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
  const candidates = buildReasoningProviderOptionsCandidates(model, runtimeProviderName)
  return candidates[0]
}

/**
 * Build ordered fallback candidates for providerOptions.
 * The stream layer tries these from strongest -> safest, then without providerOptions.
 */
export function buildReasoningProviderOptionsCandidates(
  model: Pick<ProviderConfig, "provider" | "id" | "reasoningEffort">,
  runtimeProviderName: string
): Array<ProviderOptionsRecord | undefined> {
  const effort = resolveReasoningEffort(model.reasoningEffort, model.id)
  if (!effort) return [undefined]

  const runtime = runtimeProviderName.toLowerCase()
  const configured = model.provider.toLowerCase()
  const isMiniMaxModel = model.id.toLowerCase().includes("minimax")

  // Anthropic
  if (runtime === "anthropic" || configured === "anthropic") {
    if (effort === "none") return [undefined]
    return dedupeCandidates([
      {
        anthropic: {
          thinking: {
            type: "enabled" as const,
            budgetTokens: anthropicBudgetFromEffort(effort),
          },
        },
      },
      {
        anthropic: {
          thinking: {
            type: "enabled" as const,
            budgetTokens: Math.max(1024, Math.floor(anthropicBudgetFromEffort(effort) / 2)),
          },
        },
      },
      undefined,
    ])
  }

  // Google
  if (runtime === "google" || configured === "google") {
    if (effort === "none") return [undefined]
    const level = effortToLevel(effort)
    return dedupeCandidates([
      level
        ? {
            google: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingLevel: level,
              },
            },
          }
        : undefined,
      {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            thinkingBudget: googleBudgetFromEffort(effort),
          },
        },
      },
      undefined,
    ])
  }

  // Bedrock
  if (runtime === "bedrock" || configured === "bedrock") {
    if (effort === "none") return [undefined]
    return dedupeCandidates([
      {
        bedrock: {
          reasoningConfig: {
            type: "enabled" as const,
            budgetTokens: anthropicBudgetFromEffort(effort),
          },
        },
      },
      {
        bedrock: {
          reasoningConfig: {
            type: "enabled" as const,
          },
        },
      },
      undefined,
    ])
  }

  // OpenAI-like family (native + compatible gateways)
  if (!OPENAI_LIKE_PROVIDER_NAMES.has(runtime) && !OPENAI_LIKE_PROVIDER_NAMES.has(configured)) {
    return [undefined]
  }

  const candidates: Array<ProviderOptionsRecord | undefined> = []
  const effortValue = effort === "none" ? "none" : effort
  const thinkingState = effort === "none" ? "disabled" : "enabled"
  const applyProviderKeys = (opts: ProviderOptionsRecord): void => {
    candidates.push({ [runtimeProviderName]: opts, openai: opts })
    candidates.push({ [runtimeProviderName]: opts })
    candidates.push({ openai: opts })
  }

  // AI SDK-style; works for OpenAI/OpenRouter/OpenAI-compatible providers.
  applyProviderKeys({
    reasoningEffort: effortValue,
    ...(isMiniMaxModel ? { thinking: { type: thinkingState } } : {}),
  })

  // OpenAI Responses-style nested field.
  applyProviderKeys({
    reasoning: effort === "none"
      ? { effort: "low", enabled: false }
      : { effort },
    ...(isMiniMaxModel ? { thinking: { type: thinkingState } } : {}),
  })

  // snake_case compatibility for gateways/proxies.
  applyProviderKeys({
    reasoning_effort: effortValue,
    ...(isMiniMaxModel ? { thinking: { type: thinkingState } } : {}),
  })

  // Some gateways only forward custom keys via extra_body.
  applyProviderKeys({
    extra_body: {
      reasoning_effort: effortValue,
    },
  })
  applyProviderKeys({
    extra_body: {
      reasoning: effort === "none"
        ? { effort: "low", enabled: false }
        : { effort },
    },
  })
  if (isMiniMaxModel) {
    applyProviderKeys({
      extra_body: {
        thinking: { type: thinkingState },
      },
    })
  }

  candidates.push(undefined)
  return dedupeCandidates(candidates)
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

function stableStringify(value: unknown): string {
  return JSON.stringify(sortObjectDeep(value))
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
    id.includes("claude") ||
    id.includes("gemini") ||
    id.includes("grok") ||
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
