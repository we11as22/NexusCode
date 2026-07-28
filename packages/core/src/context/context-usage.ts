/**
 * Unified context / token display for CLI, VS Code, and agent loop.
 * Aligns with what we send to the model: active message window, capped tool outputs, system prompt, tools list overhead.
 */
import { zodSchema } from "ai"
import type { z } from "zod"
import { estimateTokens } from "./condense.js"
import { getMessagesForActiveContext } from "../session/active-context.js"
import type {
  ImagePart,
  MessagePart,
  ProviderContextAnchor,
  ReasoningPart,
  SessionMessage,
  ToolPart,
} from "../types.js"

const PENDING_ESTIMATE_SAFETY_FACTOR = 1.1

/**
 * Model context window limit: config override or known defaults by model id substring.
 */
export function getContextWindowLimit(modelId: string, configuredLimit?: number): number {
  if (typeof configuredLimit === "number" && Number.isFinite(configuredLimit) && configuredLimit > 0) {
    return Math.floor(configuredLimit)
  }
  const lower = modelId.toLowerCase()
  // Prefer provider/catalog metadata through configuredLimit. These fallbacks
  // cover common manually-entered model ids and intentionally stay
  // conservative when the route is unknown.
  if (lower.includes("minimax-m2.5")) return 196_608
  if (lower.includes("minimax-m2.7")) return 204_800
  if (lower.includes("kilo-auto/free")) return 256_000
  if (lower.includes("qwen3-coder-plus")) return 1_000_000
  if (lower.includes("qwen3-coder-next")) return 262_144
  if (lower.includes("gpt-5")) return 272_000
  if (lower.includes("claude-3") || lower.includes("claude-4") || lower.includes("claude-sonnet") || lower.includes("claude-opus")) {
    return 200_000
  }
  if (lower.includes("gpt-4o")) return 128_000
  if (lower.includes("gpt-4")) return 128_000
  if (lower.includes("gpt-3.5")) return 16_000
  if (lower.includes("gemini-2")) return 1_000_000
  if (lower.includes("gemini")) return 200_000
  return 0
}

function estimateToolResultTokens(part: ToolPart): number {
  if (part.compacted) return estimateTokens("[Old tool result content cleared]")
  return part.output ? estimateTokens(part.output) : 0
}

function estimateMessageTokens(message: SessionMessage): number {
  if (typeof message.content === "string") {
    return estimateTokens(message.content)
  }
  let total = 0
  for (const part of message.content as MessagePart[]) {
    if (part.type === "text") {
      total += estimateTokens(part.text)
    } else if (part.type === "reasoning") {
      total += estimateTokens((part as ReasoningPart).text ?? "")
    } else if (part.type === "image") {
      const image = part as ImagePart
      total += Math.ceil((image.data?.length ?? 0) / 4)
    } else if (part.type === "tool") {
      const tool = part as ToolPart
      if (tool.input) total += estimateTokens(JSON.stringify(tool.input))
      total += estimateToolResultTokens(tool)
    }
  }
  return total
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
    total += estimateMessageTokens(msg)
  }
  return total
}

/**
 * Conservative estimate of the exact tool definitions sent to the provider.
 */
export function estimateToolsDefinitionsTokens(
  tools: Array<{
    name: string
    description: string
    parameters?: z.ZodType<unknown>
  }>,
): number {
  let n = 0
  for (const t of tools) {
    const schema = t.parameters
      ? zodSchema(t.parameters).jsonSchema
      : { type: "object", properties: {} }
    n += estimateTokens(
      JSON.stringify({
        name: t.name,
        description: t.description,
        parameters: schema,
      }),
    )
  }
  return Math.ceil(n * PENDING_ESTIMATE_SAFETY_FACTOR)
}

export type ContextUsageSnapshot = {
  usedTokens: number
  limitTokens: number
  percent: number
  source: "provider" | "hybrid" | "estimated"
  providerTokens: number
  pendingTokens: number
  modelId: string
}

export type PersistedContextUsage = {
  usedTokens: number
  limitTokens: number
  percent: number
  source?: "provider" | "hybrid" | "estimated"
  providerTokens?: number
  pendingTokens?: number
  modelId?: string
}

/**
 * A persisted usage sample is only meaningful for the model that produced it.
 * Legacy samples had no model identity and could keep an obsolete 128k limit
 * on screen after a provider/catalog update. Reject those samples and let the
 * caller rebuild usage from the active session. For a matching model, retain
 * the provider-measured used tokens but refresh the limit from current model
 * metadata.
 */
export function reconcilePersistedContextUsage(
  snapshot: PersistedContextUsage | undefined,
  modelId: string,
  configuredContextWindow?: number,
): PersistedContextUsage | undefined {
  if (!snapshot?.modelId || snapshot.modelId !== modelId) return undefined
  const limitTokens = getContextWindowLimit(modelId, configuredContextWindow)
  return {
    ...snapshot,
    limitTokens,
    percent:
      limitTokens > 0
        ? Math.min(100, Math.round((snapshot.usedTokens / limitTokens) * 100))
        : 0,
  }
}

function estimatePendingAfterAnchor(
  messages: SessionMessage[],
  anchor: ProviderContextAnchor,
): number | null {
  const activeMessages = getMessagesForActiveContext(messages)
  const anchorIndex = activeMessages.findIndex(
    (message) => message.id === anchor.messageId,
  )
  if (anchorIndex < 0) return null

  let pending = 0
  const anchorMessage = activeMessages[anchorIndex]
  if (
    anchorMessage?.role === "assistant" &&
    Array.isArray(anchorMessage.content)
  ) {
    for (const part of anchorMessage.content as MessagePart[]) {
      if (part.type === "tool") {
        pending += estimateToolResultTokens(part as ToolPart)
      }
    }
  }
  for (let index = anchorIndex + 1; index < activeMessages.length; index++) {
    pending += estimateMessageTokens(activeMessages[index]!)
  }
  return pending
}

export function computeContextUsageMetrics(opts: {
  sessionMessages: SessionMessage[]
  systemPromptText?: string
  toolsDefinitionTokens?: number
  modelId: string
  configuredContextWindow?: number
  providerAnchor?: ProviderContextAnchor
}): ContextUsageSnapshot & { sessionTokens: number; systemTokens: number; toolsTokens: number } {
  const sessionTokens = estimateActiveContextSessionTokens(opts.sessionMessages)
  const systemTokens = opts.systemPromptText ? estimateTokens(opts.systemPromptText) : 0
  const toolsTokens = opts.toolsDefinitionTokens ?? 0
  const manifestTokens = systemTokens + toolsTokens
  const anchor =
    opts.providerAnchor &&
    (!opts.providerAnchor.modelId ||
      opts.providerAnchor.modelId === opts.modelId)
      ? opts.providerAnchor
      : undefined
  const pendingAfterAnchor = anchor
    ? estimatePendingAfterAnchor(opts.sessionMessages, anchor)
    : null
  const manifestDelta = anchor
    ? Math.max(0, manifestTokens - anchor.manifestTokens)
    : 0
  const rawPending =
    pendingAfterAnchor == null
      ? 0
      : pendingAfterAnchor + manifestDelta
  const pendingTokens =
    rawPending > 0
      ? Math.ceil(rawPending * PENDING_ESTIMATE_SAFETY_FACTOR)
      : 0
  const providerTokens =
    anchor && pendingAfterAnchor != null ? anchor.usedTokens : 0
  const source: ContextUsageSnapshot["source"] =
    providerTokens > 0
      ? pendingTokens > 0
        ? "hybrid"
        : "provider"
      : "estimated"
  const usedTokens =
    source === "estimated"
      ? sessionTokens + manifestTokens
      : providerTokens + pendingTokens
  const limitTokens = getContextWindowLimit(opts.modelId, opts.configuredContextWindow)
  const percent = limitTokens > 0 ? Math.min(100, Math.round((usedTokens / limitTokens) * 100)) : 0
  return {
    sessionTokens,
    systemTokens,
    toolsTokens,
    usedTokens,
    limitTokens,
    percent,
    source,
    providerTokens,
    pendingTokens,
    modelId: opts.modelId,
  }
}
