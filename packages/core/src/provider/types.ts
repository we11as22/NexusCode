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
  role: "user" | "assistant" | "system"
  content: LLMMessageContent
}

export type LLMMessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
      | { type: "tool_call"; toolCallId: string; toolName: string; args: Record<string, unknown> }
      | { type: "tool_result"; toolCallId: string; result: string; isError?: boolean }
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
