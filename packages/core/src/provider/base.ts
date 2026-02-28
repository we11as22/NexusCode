import { streamText, generateObject, type LanguageModelV1 } from "ai"
import type { z } from "zod"
import type {
  LLMClient,
  LLMStreamEvent,
  StreamOptions,
  GenerateOptions,
} from "./types.js"
import { generateStructuredWithFallback, supportsStructuredOutput } from "./structured-output.js"

/**
 * Base LLM client implementation using Vercel AI SDK.
 * Handles streaming, tool calls, reasoning blocks, and structured output.
 */
export class BaseLLMClient implements LLMClient {
  constructor(
    protected model: LanguageModelV1,
    readonly providerName: string,
    readonly modelId: string
  ) {}

  getModel(): LanguageModelV1 {
    return this.model
  }

  supportsStructuredOutput(): boolean {
    return supportsStructuredOutput(this.providerName, this.modelId)
  }

  async *stream(opts: StreamOptions): AsyncIterable<LLMStreamEvent> {
    const tools = opts.tools
      ? Object.fromEntries(
          opts.tools.map(t => [
            t.name,
            {
              description: t.description,
              parameters: t.parameters as z.ZodType<unknown>,
            },
          ])
        )
      : undefined

    const messages = buildAISDKMessages(opts.messages)

    let systemPrompt = opts.systemPrompt
    // For Anthropic, inject cache_control markers if cacheableSystemBlocks is set
    // (This is handled per-provider, not here — the Anthropic provider overrides)

    const result = streamText({
      model: this.model,
      system: systemPrompt,
      messages,
      tools,
      maxTokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature,
      abortSignal: opts.signal,
      maxSteps: 1, // We handle multi-step manually in agentLoop
    })

    let hasError = false

    for await (const part of result.fullStream) {
      if (opts.signal?.aborted) break

      switch (part.type) {
        case "text-delta":
          yield { type: "text_delta", delta: part.textDelta }
          break

        case "reasoning":
          yield { type: "reasoning_delta", delta: (part as Record<string, string>)["textDelta"] ?? "" }
          break

        case "tool-call":
          yield {
            type: "tool_call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            toolInput: part.args as Record<string, unknown>,
          }
          break

        case "tool-result":
          yield {
            type: "tool_result",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            toolOutput: typeof part.result === "string" ? part.result : JSON.stringify(part.result),
          }
          break

        case "finish": {
          const usage = result.usage
          yield {
            type: "finish",
            finishReason: part.finishReason as LLMStreamEvent["finishReason"],
            usage: {
              inputTokens: (await usage)?.promptTokens ?? 0,
              outputTokens: (await usage)?.completionTokens ?? 0,
            },
          }
          break
        }

        case "error":
          hasError = true
          yield { type: "error", error: part.error instanceof Error ? part.error : new Error(String(part.error)) }
          break
      }
    }

    if (!hasError) {
      // Ensure finish is always yielded
    }
  }

  async generateStructured<T>(opts: GenerateOptions<T>): Promise<T> {
    return generateStructuredWithFallback(this, opts)
  }
}

function buildAISDKMessages(messages: StreamOptions["messages"]): Parameters<typeof streamText>[0]["messages"] {
  const result: Parameters<typeof streamText>[0]["messages"] = []

  for (const msg of messages) {
    if (msg.role === "system") continue // handled via system param

    if (typeof msg.content === "string") {
      result.push({ role: msg.role as "user" | "assistant", content: msg.content })
      continue
    }

    // Handle complex content
    const parts: unknown[] = []
    for (const part of msg.content) {
      switch (part.type) {
        case "text":
          parts.push({ type: "text", text: part.text })
          break
        case "image":
          parts.push({ type: "image", image: part.data, mimeType: part.mimeType })
          break
        case "tool_call":
          parts.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
          })
          break
        case "tool_result":
          parts.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: "",
            result: [{ type: "text", text: part.result }],
            isError: part.isError,
          })
          break
      }
    }
    result.push({ role: msg.role as "user" | "assistant", content: parts as string })
  }

  return result
}
