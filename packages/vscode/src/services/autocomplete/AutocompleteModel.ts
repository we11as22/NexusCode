import * as vscode from "vscode"
import { createLLMClient, type NexusConfig, type ProviderConfig, type ProviderName } from "@nexuscode/core"
import { ResponseMetaData } from "./types"

const FIM_SYSTEM = `You are an inline code completion engine. The user shows code before the cursor (PREFIX) and after the cursor (SUFFIX). Output ONLY the raw text to insert at the gap — no quotes, no markdown code fences, no explanation. Prefer a natural stopping point (end of statement, closing bracket, or line). If nothing sensible fits, output nothing.`

const PROVIDERS: ProviderName[] = [
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
]

function normalizeAutocompleteProvider(raw: string): { provider: ProviderName; defaultBaseUrl?: string } | null {
  let p = raw.trim()
  let defaultBaseUrl: string | undefined
  if (p === "openrouter") {
    p = "openai-compatible"
    defaultBaseUrl = "https://openrouter.ai/api/v1"
  }
  if (!PROVIDERS.includes(p as ProviderName)) return null
  return { provider: p as ProviderName, defaultBaseUrl }
}

/** VS Code settings override when `nexuscode.autocomplete.useSeparateModel` is true. */
export function buildAutocompleteOverrideModel(): ProviderConfig | null {
  const c = vscode.workspace.getConfiguration()
  if (!(c.get<boolean>("nexuscode.autocomplete.useSeparateModel") ?? false)) {
    return null
  }
  const norm = normalizeAutocompleteProvider(c.get<string>("nexuscode.autocomplete.provider") ?? "")
  const id = (c.get<string>("nexuscode.autocomplete.model") ?? "").trim()
  if (!norm || !id) return null

  let baseUrl = (c.get<string>("nexuscode.autocomplete.baseUrl") ?? "").trim() || undefined
  if (!baseUrl && norm.defaultBaseUrl) baseUrl = norm.defaultBaseUrl

  const apiKey = (c.get<string>("nexuscode.autocomplete.apiKey") ?? "").trim() || undefined
  const temp = c.get<number>("nexuscode.autocomplete.temperature")
  const reasoningEffort = (c.get<string>("nexuscode.autocomplete.reasoningEffort") ?? "").trim() || undefined
  const cw = c.get<number>("nexuscode.autocomplete.contextWindow")

  const cfg: ProviderConfig = {
    provider: norm.provider,
    id,
    baseUrl,
    apiKey,
    temperature: typeof temp === "number" && !Number.isNaN(temp) ? temp : 0.2,
  }
  if (reasoningEffort) cfg.reasoningEffort = reasoningEffort
  if (typeof cw === "number" && cw > 0) cfg.contextWindow = cw
  return cfg
}

/** Chunk from an LLM streaming response (legacy shape; FIM uses generateFimResponse). */
export type ApiStreamChunk =
  | { type: "text"; text: string }
  | {
      type: "usage"
      totalCost?: number
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    }

export class AutocompleteModel {
  public profileName: string | null = null
  public profileType: string | null = null

  constructor(private readonly getNexusConfig: () => NexusConfig | undefined) {}

  public supportsFim(): boolean {
    return true
  }

  private tryGetEffectiveModel(): ProviderConfig | null {
    const override = buildAutocompleteOverrideModel()
    if (override) return override
    const agent = this.getNexusConfig()?.model
    if (!agent?.id || !agent?.provider) return null
    return agent
  }

  /**
   * Prefix/suffix are formatted by the FIM prompt builder (Kilocode-derived templates + context).
   * Uses agent model from YAML unless `nexuscode.autocomplete.useSeparateModel` and fields are set.
   */
  public async generateFimResponse(
    prefix: string,
    suffix: string,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ResponseMetaData> {
    const modelCfg = this.tryGetEffectiveModel()
    if (!modelCfg) {
      throw new Error("NexusCode: no model configured for autocomplete (agent YAML or autocomplete override in settings)")
    }

    const client = createLLMClient(modelCfg)
    const userContent = `The gap to fill is between PREFIX and SUFFIX below. Reply with only the insertion.

PREFIX:
\`\`\`
${prefix}
\`\`\`

SUFFIX:
\`\`\`
${suffix}
\`\`\`

INSERTION:`

    let inputTokens = 0
    let outputTokens = 0
    let cost = 0

    for await (const event of client.stream({
      messages: [{ role: "user", content: userContent }],
      systemPrompt: FIM_SYSTEM,
      signal,
      maxTokens: 256,
      temperature: modelCfg.temperature ?? 0.2,
      maxRetries: 1,
    })) {
      if (event.type === "text_delta" && event.delta) {
        onChunk(event.delta)
      }
      if (event.type === "finish" && event.usage) {
        inputTokens = event.usage.inputTokens ?? 0
        outputTokens = event.usage.outputTokens ?? 0
      }
      if (event.type === "error" && event.error) {
        throw event.error
      }
    }

    return {
      cost,
      inputTokens,
      outputTokens,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    }
  }

  public async generateResponse(
    _systemPrompt: string,
    _userPrompt: string,
    _onChunk: (chunk: ApiStreamChunk) => void,
  ): Promise<ResponseMetaData> {
    throw new Error("Use generateFimResponse for NexusCode autocomplete.")
  }

  public getModelName(): string {
    return this.tryGetEffectiveModel()?.id ?? ""
  }

  public getProviderDisplayName(): string {
    return this.tryGetEffectiveModel()?.provider ?? ""
  }

  public hasValidCredentials(): boolean {
    return this.tryGetEffectiveModel() != null
  }

  public async hasBalance(): Promise<boolean> {
    return this.hasValidCredentials()
  }
}
