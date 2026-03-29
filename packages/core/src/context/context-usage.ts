/**
 * Unified context / token display for CLI, VS Code, and agent loop.
 * Aligns with what we send to the model: active message window, capped tool outputs, system prompt, tools list overhead.
 */
import { estimateTokens } from "./condense.js"
import { getMessagesForActiveContext } from "../session/active-context.js"
import type { SessionMessage, MessagePart, ToolPart, ReasoningPart, ImagePart } from "../types.js"

/** Heuristic extra tokens per tool for JSON-schema / wire overhead (per tool, on top of name+description). */
const TOOL_SCHEMA_OVERHEAD_TOKENS = 750

/**
 * Model context window limit: config override or known defaults by model id substring.
 */
export function getContextWindowLimit(modelId: string, configuredLimit?: number): number {
  if (typeof configuredLimit === "number" && Number.isFinite(configuredLimit) && configuredLimit > 0) {
    return Math.floor(configuredLimit)
  }
  const lower = modelId.toLowerCase()
  if (lower.includes("claude-3") || lower.includes("claude-4") || lower.includes("claude-sonnet") || lower.includes("claude-opus")) {
    return 200_000
  }
  if (lower.includes("gpt-4o")) return 128_000
  if (lower.includes("gpt-4")) return 128_000
  if (lower.includes("gpt-3.5")) return 16_000
  if (lower.includes("gemini-2")) return 1_000_000
  if (lower.includes("gemini")) return 200_000
  return 128_000
}

/**
 * Token estimate for messages that count toward the next model request (active context only).
 * Includes reasoning and images; tool outputs use stored text (already truncated at execution when huge).
 */
export function estimateActiveContextSessionTokens(messages: SessionMessage[]): number {
  let total = 0
  for (const msg of getMessagesForActiveContext(messages)) {
    if (msg.summary) {
      if (typeof msg.content === "string") {
        total += estimateTokens(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as MessagePart[]) {
          if (part.type === "text") total += estimateTokens(part.text)
        }
      }
      continue
    }
    if (typeof msg.content === "string") {
      total += estimateTokens(msg.content)
      continue
    }
    for (const part of msg.content as MessagePart[]) {
      if (part.type === "text") {
        total += estimateTokens(part.text)
      } else if (part.type === "reasoning") {
        total += estimateTokens((part as ReasoningPart).text ?? "")
      } else if (part.type === "image") {
        const ip = part as ImagePart
        total += Math.ceil((ip.data?.length ?? 0) / 4)
      } else if (part.type === "tool") {
        const tp = part as ToolPart
        if (tp.input) {
          total += estimateTokens(JSON.stringify(tp.input))
        }
        if (tp.compacted) {
          total += estimateTokens("[Old tool result content cleared]")
        } else if (tp.output) {
          total += estimateTokens(tp.output)
        }
      }
    }
  }
  return total
}

/**
 * Rough token overhead for tool definitions sent with each request (name + description + schema fudge).
 */
export function estimateToolsDefinitionsTokens(tools: Array<{ name: string; description: string }>): number {
  let n = 0
  for (const t of tools) {
    n += estimateTokens(`${t.name}\n${t.description}`)
    n += TOOL_SCHEMA_OVERHEAD_TOKENS
  }
  return n
}

export type ContextUsageSnapshot = {
  usedTokens: number
  limitTokens: number
  percent: number
}

export function computeContextUsageMetrics(opts: {
  sessionMessages: SessionMessage[]
  systemPromptText?: string
  toolsDefinitionTokens?: number
  modelId: string
  configuredContextWindow?: number
}): ContextUsageSnapshot & { sessionTokens: number; systemTokens: number; toolsTokens: number } {
  const sessionTokens = estimateActiveContextSessionTokens(opts.sessionMessages)
  const systemTokens = opts.systemPromptText ? estimateTokens(opts.systemPromptText) : 0
  const toolsTokens = opts.toolsDefinitionTokens ?? 0
  const usedTokens = sessionTokens + systemTokens + toolsTokens
  const limitTokens = getContextWindowLimit(opts.modelId, opts.configuredContextWindow)
  const percent = limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 100)) : 0
  return { sessionTokens, systemTokens, toolsTokens, usedTokens, limitTokens, percent }
}
