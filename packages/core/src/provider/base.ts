import { streamText, type LanguageModelV1 } from "ai"
import type { z } from "zod"
import type {
  LLMClient,
  LLMStreamEvent,
  StreamOptions,
  GenerateOptions,
} from "./types.js"
import { generateStructuredWithFallback, supportsStructuredOutput } from "./structured-output.js"

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_INITIAL_DELAY = 1000
const DEFAULT_MAX_DELAY = 30_000
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * Base LLM client implementation using Vercel AI SDK.
 * Handles streaming, tool calls, reasoning blocks, structured output and retry.
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
    // Tools are always sent with zod parameters; AI SDK converts to JSON Schema for the provider.
    // When the provider supports structured output, tool-call args conform to that schema.
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

    let attempt = 0
    const maxAttempts = opts.maxRetries ?? DEFAULT_MAX_RETRIES
    const initialDelay = DEFAULT_INITIAL_DELAY
    const maxDelay = DEFAULT_MAX_DELAY

    while (true) {
      attempt++
      try {
        yield* this._streamOnce(opts, messages, tools)
        return
      } catch (err) {
        if (opts.signal?.aborted) throw err
        const status = getErrorStatus(err)
        const isRetryable = status ? RETRYABLE_STATUS.has(status) : isNetworkError(err)

        if (!isRetryable || attempt >= maxAttempts) {
          throw err
        }

        // Exponential backoff with jitter
        const delay = Math.min(
          initialDelay * Math.pow(2, attempt - 1) + Math.random() * 500,
          maxDelay
        )
        yield { type: "error", error: new Error(`Retrying after error (attempt ${attempt}/${maxAttempts}): ${String(err)}`) }
        await sleep(delay, opts.signal)
      }
    }
  }

  private async *_streamOnce(
    opts: StreamOptions,
    messages: Parameters<typeof streamText>[0]["messages"],
    tools: Record<string, { description: string; parameters: z.ZodType<unknown> }> | undefined
  ): AsyncIterable<LLMStreamEvent> {
    const result = streamText({
      model: this.model,
      system: opts.systemPrompt,
      messages,
      tools,
      maxTokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature,
      abortSignal: opts.signal,
      maxSteps: 1, // We handle multi-step manually in agentLoop
    })

    for await (const part of result.fullStream) {
      if (opts.signal?.aborted) break

      // AI SDK may emit reasoning-part-finish; types may not include it yet
      if ((part as { type: string }).type === "reasoning-part-finish") continue

      switch (part.type) {
        case "text-delta":
          yield { type: "text_delta", delta: part.textDelta }
          break

        case "reasoning":
          // Support both textDelta (streaming) and text (chunk) for reasoning/thinking models (OpenRouter, o1, DeepSeek R1, etc.)
          yield {
            type: "reasoning_delta",
            delta:
              (part as Record<string, string>)["textDelta"] ??
              (part as Record<string, string>)["text"] ??
              "",
          }
          break

        case "tool-call":
          yield {
            type: "tool_call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            toolInput: part.args as Record<string, unknown>,
          }
          break

        case "finish": {
          const usage = result.usage
          const usageData = await usage.catch(() => null)
          yield {
            type: "finish",
            finishReason: part.finishReason as LLMStreamEvent["finishReason"],
            usage: {
              inputTokens: usageData?.promptTokens ?? 0,
              outputTokens: usageData?.completionTokens ?? 0,
            },
          }
          break
        }

        case "error":
          yield { type: "error", error: part.error instanceof Error ? part.error : new Error(String(part.error)) }
          break
      }
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
      if (msg.role === "tool") continue // skip legacy string-content tool messages
      result.push({ role: msg.role as "user" | "assistant", content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content) || msg.content.length === 0) continue

    // Tool result messages (role === "tool") are converted to plain user text.
    // This keeps compatibility with AI SDK message typings that do not accept role "tool".
    if (msg.role === "tool") {
      const toolResultLines = msg.content
        .filter(p => p.type === "tool-result")
        .map(p => {
          const tr = p as { type: "tool-result"; toolCallId: string; toolName: string; result: string; isError?: boolean }
          const toolName = tr.toolName ?? "unknown_tool"
          const prefix = tr.isError ? "TOOL_ERROR" : "TOOL_RESULT"
          return `${prefix} ${toolName} (${tr.toolCallId}): ${tr.result}`
        })
      if (toolResultLines.length > 0) {
        result.push({ role: "user", content: toolResultLines.join("\n") })
      }
      continue
    }

    // User / assistant messages with complex content
    const parts: unknown[] = []
    for (const part of msg.content) {
      switch (part.type) {
        case "text":
          parts.push({ type: "text", text: part.text })
          break
        case "image":
          parts.push({ type: "image", image: part.data, mimeType: part.mimeType })
          break
        case "tool-call":
          parts.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.args,
          })
          break
        case "tool-result":
          parts.push({
            type: "tool-result",
            toolCallId: part.toolCallId,
            toolName: part.toolName ?? "",
            result: [{ type: "text", text: part.result }],
            isError: part.isError ?? false,
          })
          break
      }
    }
    if (parts.length > 0) {
      result.push({ role: msg.role as "user" | "assistant", content: parts as any })
    }
  }

  return result
}

function getErrorStatus(err: unknown): number | null {
  if (err && typeof err === "object") {
    const status = (err as Record<string, unknown>)["statusCode"]
      ?? (err as Record<string, unknown>)["status"]
    if (typeof status === "number") return status
  }
  const msg = String(err)
  const m = msg.match(/(?:status|code)[^\d]*(\d{3})/i)
  if (m) return parseInt(m[1]!)
  return null
}

function isNetworkError(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  return (
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("network") ||
    msg.includes("socket") ||
    msg.includes("fetch failed")
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(new Error("Aborted"))
    })
  })
}
