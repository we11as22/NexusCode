import type { ReasoningHistoryMode } from "./types.js"

type SdkMessage = Record<string, unknown> & {
  role?: string
  content?: unknown
  providerOptions?: Record<string, unknown>
}

/**
 * KiloCode / models.dev: interleaved APIs carry prior assistant reasoning on the message
 * as `providerOptions.openaiCompatible.reasoning_content` (or `reasoning_details`), not as
 * separate `content` parts.
 */
export function resolveInterleavedReasoningField(
  mode: ReasoningHistoryMode,
  modelId: string,
): "reasoning_content" | "reasoning_details" | undefined {
  if (mode === "inline") return undefined
  if (mode === "reasoning_content") return "reasoning_content"
  if (mode === "reasoning_details") return "reasoning_details"

  const id = modelId.toLowerCase()
  // Primary case from KiloCode ProviderTransform tests & DeepSeek OpenAI-compatible APIs.
  if (id.includes("deepseek")) return "reasoning_content"

  return undefined
}

/**
 * KiloCode `ProviderTransform.normalizeMessages`: Anthropic rejects empty string messages
 * and empty text/reasoning parts in array content.
 */
export function dropEmptyAnthropicContent(messages: SdkMessage[]): void {
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    if (typeof msg.content === "string") {
      if (msg.content === "") {
        messages.splice(mi, 1)
        mi--
      }
      continue
    }
    if (!Array.isArray(msg.content)) continue

    const filtered = msg.content.filter((part: unknown) => {
      const p = part as { type?: string; text?: string }
      if (p.type === "text" || p.type === "reasoning") {
        return typeof p.text === "string" && p.text !== ""
      }
      return true
    })

    if (filtered.length === 0) {
      messages.splice(mi, 1)
      mi--
      continue
    }
    msg.content = filtered
  }
}

/**
 * Hoist `type: "reasoning"` parts from assistant array content into
 * `providerOptions.openaiCompatible[reasoning_content|reasoning_details]` (KiloCode interleaved path).
 */
export function hoistAssistantReasoningToProviderOptions(
  messages: SdkMessage[],
  field: "reasoning_content" | "reasoning_details",
): void {
  for (const msg of messages) {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue

    const reasoningParts = msg.content.filter((p: unknown) => (p as { type?: string }).type === "reasoning")
    const reasoningText = reasoningParts
      .map((p: unknown) => String((p as { text?: string }).text ?? ""))
      .join("")
    const filteredContent = msg.content.filter((p: unknown) => (p as { type?: string }).type !== "reasoning")

    if (!reasoningText) {
      msg.content = filteredContent
      continue
    }

    // Interleaved APIs still expect non-empty assistant content when only reasoning was present.
    msg.content =
      filteredContent.length > 0
        ? filteredContent
        : ([{ type: "text", text: " " }] as unknown[])
    const opts = (msg.providerOptions ?? {}) as Record<string, unknown>
    const openaiCompatibleExisting = opts.openaiCompatible as Record<string, unknown> | undefined
    msg.providerOptions = {
      ...opts,
      openaiCompatible: {
        ...(openaiCompatibleExisting ?? {}),
        [field]: reasoningText,
      },
    }
  }
}

export function normalizeReasoningHistoryForSdkMessages(
  messages: SdkMessage[],
  opts: {
    anthropicPipeline: boolean
    interleavedField?: "reasoning_content" | "reasoning_details"
  },
): void {
  if (opts.anthropicPipeline) {
    dropEmptyAnthropicContent(messages)
  }
  if (opts.interleavedField) {
    hoistAssistantReasoningToProviderOptions(messages, opts.interleavedField)
  }
}
