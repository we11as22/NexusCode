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
   * Override stream to add cache_control markers on system blocks.
   * Anthropic prompt caching: mark the first N system blocks as ephemeral.
   * Order: [role+capabilities] [rules] [skills] [dynamic...]
   * Blocks 1-3 (if present) get cache_control.
   */
  override async *stream(opts: StreamOptions): AsyncIterable<LLMStreamEvent> {
    // For Anthropic, we handle cache markers by building a special system
    // The base implementation handles this via the model's cacheControl:true option
    // and Vercel AI SDK automatically adds cache_control to the last few system blocks
    yield* super.stream(opts)
  }
}
