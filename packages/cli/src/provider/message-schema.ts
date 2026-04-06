import type {
  ContentBlock as AnthropicContentBlock,
  ImageBlockParam as AnthropicImageBlockParam,
  Message as AnthropicMessage,
  MessageParam as AnthropicMessageParam,
  TextBlock as AnthropicTextBlock,
  TextBlockParam as AnthropicTextBlockParam,
  ToolResultBlockParam as AnthropicToolResultBlockParam,
  ToolUseBlock as AnthropicToolUseBlock,
  ToolUseBlockParam as AnthropicToolUseBlockParam,
  Usage as AnthropicUsage,
} from '@anthropic-ai/sdk/resources/index.mjs'

export type TextBlock = AnthropicTextBlock
export type TextBlockParam = AnthropicTextBlockParam
export type ImageBlockParam = AnthropicImageBlockParam
export type ImageMediaType =
  ImageBlockParam['source'] extends { media_type: infer T } ? T : never
export type ToolUseBlock = AnthropicToolUseBlock
export type ToolUseBlockParam = AnthropicToolUseBlockParam
export type ToolResultBlockParam = AnthropicToolResultBlockParam

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature: string
}

export interface ThinkingBlockParam extends ThinkingBlock {}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

export interface RedactedThinkingBlockParam extends RedactedThinkingBlock {}

export interface DocumentBlockParam {
  type: 'document'
  source?: unknown
  title?: string
  context?: string
  citations?: { enabled?: boolean }
}

export type ContentBlock =
  | AnthropicContentBlock
  | ThinkingBlock
  | RedactedThinkingBlock

export type MessageContentBlockParam =
  | TextBlockParam
  | ImageBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam

export type MessageParam = AnthropicMessageParam

export type AssistantRequestContentBlock =
  | TextBlockParam
  | ImageBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlockParam

export interface AssistantRequestMessageParam {
  role: 'assistant'
  content: string | AssistantRequestContentBlock[]
}

export type RequestMessageParam = MessageParam | AssistantRequestMessageParam

export interface UsageWithCache extends AnthropicUsage {
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface AssistantAPIMessage
  extends Omit<AnthropicMessage, 'content' | 'usage'> {
  content: ContentBlock[]
  usage: UsageWithCache
}
