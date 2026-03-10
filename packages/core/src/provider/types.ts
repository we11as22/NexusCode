import type { LanguageModelV1, LanguageModelV1StreamPart } from "ai"
import type { z } from "zod"

export interface LLMStreamEvent {
  type:
    | "text_delta"
    | "reasoning_delta"
    | "reasoning_end"
    | "tool_input_start"
    | "tool_call"
    | "tool_result"
    | "finish"
    | "error"
  // text events
  delta?: string
  // tool events
  toolCallId?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  // finish event
  finishReason?: "stop" | "length" | "tool_calls" | "error"
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  // error event
  error?: Error
}

export interface LLMMessage {
  role: "user" | "assistant" | "system" | "tool"
  content: LLMMessageContent
}

export type LLMMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
      // AI SDK uses "tool-call" (with dash) — this must match exactly
      | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
      | { type: "tool-result"; toolCallId: string; toolName: string; result: string; isError?: boolean }
    >

export interface LLMToolDef {
  name: string
  description: string
  parameters: z.ZodType<unknown>
}

export interface StreamOptions {
  messages: LLMMessage[]
  tools?: LLMToolDef[]
  systemPrompt?: string
  signal?: AbortSignal
  /** For cache-aware providers (Anthropic): mark which system blocks are cacheable */
  cacheableSystemBlocks?: number
  maxTokens?: number
  temperature?: number
  maxRetries?: number
  initialRetryDelayMs?: number
  maxRetryDelayMs?: number
  retryOnStatus?: number[]
  /** Provider-specific options (e.g. anthropic: { thinking: { type: 'enabled', budgetTokens } }) */
  providerOptions?: Record<string, unknown>
  /** Ordered fallback options (strongest -> safest). Stream may retry with next candidate if provider rejects reasoning params. */
  providerOptionsCandidates?: Array<Record<string, unknown> | undefined>
}

export interface GenerateOptions<T> {
  messages: LLMMessage[]
  schema: z.ZodType<T>
  systemPrompt?: string
  signal?: AbortSignal
  maxRetries?: number
}

export interface LLMClient {
  readonly providerName: string
  readonly modelId: string
  stream(opts: StreamOptions): AsyncIterable<LLMStreamEvent>
  generateStructured<T>(opts: GenerateOptions<T>): Promise<T>
  /** Check if this provider/model supports native JSON schema output */
  supportsStructuredOutput(): boolean
  /** Get model from underlying AI SDK (for direct use) */
  getModel(): LanguageModelV1
}

export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>
  readonly dimensions: number
}
