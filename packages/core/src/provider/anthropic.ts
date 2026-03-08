import { createAnthropic } from "@ai-sdk/anthropic"
import { streamText } from "ai"
import type { z } from "zod"
import type { ProviderConfig } from "../types.js"
import { BaseLLMClient } from "./base.js"
import type { StreamOptions, LLMStreamEvent } from "./types.js"

export function createAnthropicClient(config: ProviderConfig) {
  const apiKey = config.apiKey ?? process.env["ANTHROPIC_API_KEY"] ?? ""
  const anthropic = createAnthropic({
    apiKey,
    baseURL: config.baseUrl,
  })

  const model = anthropic(config.id, {
    // Enable caching for supported models
    cacheControl: true,
  })

  return new AnthropicClient(model, config.id)
}

class AnthropicClient extends BaseLLMClient {
  constructor(model: ReturnType<ReturnType<typeof createAnthropic>>, modelId: string) {
    super(model as any, "anthropic", modelId)
  }

  /**
   * Override stream to enable extended thinking by default (reasoning streamed as reasoning_delta).
   * Uses providerOptions.anthropic.thinking so Claude models that support it emit reasoning parts.
   */
  override async *stream(opts: StreamOptions): AsyncIterable<LLMStreamEvent> {
    const providerOptions = {
      ...opts.providerOptions,
      anthropic: {
        ...(typeof opts.providerOptions?.anthropic === "object" && opts.providerOptions?.anthropic !== null
          ? opts.providerOptions.anthropic
          : {}),
        thinking: { type: "enabled" as const, budgetTokens: 10_000 },
      },
    }
    yield* super.stream({ ...opts, providerOptions })
  }
}
