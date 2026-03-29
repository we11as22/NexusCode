import { streamText, type LanguageModelV1 } from "ai"
import type { z } from "zod"
import type {
  LLMClient,
  LLMStreamEvent,
  StreamOptions,
  GenerateOptions,
  ReasoningHistoryMode,
} from "./types.js"
import {
  normalizeReasoningHistoryForSdkMessages,
  resolveInterleavedReasoningField,
} from "./reasoning-history-normalize.js"
import { generateStructuredWithFallback, supportsStructuredOutput } from "./structured-output.js"

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_INITIAL_DELAY = 1000
const DEFAULT_MAX_DELAY = 30_000
const DEFAULT_RETRYABLE_STATUS = [429, 500, 502, 503, 504]

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
    // Real Zod → JSON Schema per tool so the model sees correct types (boolean, array, etc.).
    // `normalizeToolInputForParse` + stream recovery still handle common LLM/provider slop
    // before/around strict execution-time validation in `executeToolCall`.
    const baseTools = opts.tools
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

    const messages = buildAISDKMessages(
      opts.messages,
      this.providerName,
      this.modelId,
      opts.reasoningHistoryMode ?? "auto",
    )

    let attempt = 0
    const maxAttempts = opts.maxRetries ?? DEFAULT_MAX_RETRIES
    const initialDelay = opts.initialRetryDelayMs ?? DEFAULT_INITIAL_DELAY
    const maxDelay = opts.maxRetryDelayMs ?? DEFAULT_MAX_DELAY
    const retryableStatuses = new Set(opts.retryOnStatus ?? DEFAULT_RETRYABLE_STATUS)
    while (true) {
      attempt++
      try {
        yield* this._streamOnce(
          opts,
          messages,
          baseTools,
          opts.providerOptions
        )
        return
      } catch (err) {
        if (opts.signal?.aborted) throw err
        const status = getErrorStatus(err)
        const isRetryable =
          (status != null && retryableStatuses.has(status)) || isNetworkError(err)

        if (!isRetryable || attempt >= maxAttempts) {
          throw err
        }

        const retryAfterMs = getRetryAfterMs(err)
        // Exponential backoff with jitter
        const backoffDelay = Math.min(
          initialDelay * Math.pow(2, attempt - 1) + Math.random() * 500,
          maxDelay
        )
        const delay = retryAfterMs != null ? Math.min(retryAfterMs, maxDelay) : backoffDelay
        yield {
          type: "error",
          error: new Error(
            `Retrying after error (attempt ${attempt}/${maxAttempts}): ${String(err)}`
          ),
        }
        await sleep(delay, opts.signal)
      }
    }
  }

  private async *_streamOnce(
    opts: StreamOptions,
    messages: Parameters<typeof streamText>[0]["messages"],
    tools: Record<string, { description: string; parameters: z.ZodType<unknown> }> | undefined,
    providerOptions: Record<string, unknown> | undefined
  ): AsyncIterable<LLMStreamEvent> {
    const effectiveProviderOptions = withPromptCachingProviderOptions(
      providerOptions,
      this.providerName,
      opts.promptCacheKey
    )
    const thinkTagParser = createThinkTagParser()
    const guaranteeThoughtBlock = providerOptionsRequestsReasoning(effectiveProviderOptions)
    let thoughtOpen = false
    let emittedVisibleText = false
    let sawFinishEvent = false
    let streamedTextBuffer = ""
    let sawAnyTextDelta = false
    let sawAnyReasoningDelta = false
    let sawRawTextDelta = false
    let sawRawTextDone = false
    const rawTextFallbackChunks: string[] = []
    const rawReasoningFallbackChunks: string[] = []
    let currentReasoningId: string | null = null
    if (guaranteeThoughtBlock) {
      // Keep Thought UX visible even when provider streams empty/malformed reasoning chunks.
      currentReasoningId = "reasoning-0"
      yield { type: "reasoning_start", reasoningId: currentReasoningId }
      thoughtOpen = true
    }
    // Anthropic extended thinking is incompatible with temperature/top_p/top_k.
    // Drop temperature when Anthropic thinking is enabled to prevent API validation errors.
    const hasAnthropicThinking =
      effectiveProviderOptions != null &&
      typeof (effectiveProviderOptions as Record<string, unknown>)["anthropic"] === "object" &&
      typeof ((effectiveProviderOptions as Record<string, unknown>)["anthropic"] as Record<string, unknown>)["thinking"] === "object"
    const hasBedrockThinking =
      effectiveProviderOptions != null &&
      typeof (effectiveProviderOptions as Record<string, unknown>)["bedrock"] === "object" &&
      typeof ((effectiveProviderOptions as Record<string, unknown>)["bedrock"] as Record<string, unknown>)["reasoningConfig"] === "object"
    const effectiveTemperature =
      (hasAnthropicThinking || hasBedrockThinking) ? undefined : opts.temperature

    const result = streamText({
      model: this.model,
      system: opts.systemPrompt,
      messages,
      tools,
      maxTokens: opts.maxTokens ?? 8192,
      temperature: effectiveTemperature,
      topP: opts.topP,
      topK: opts.topK,
      abortSignal: opts.signal,
      maxSteps: 1, // We handle multi-step manually in agentLoop
      ...(effectiveProviderOptions && Object.keys(effectiveProviderOptions).length > 0
        ? { providerOptions: effectiveProviderOptions as any }
        : {}),
    })

    for await (const part of result.fullStream) {
      if (opts.signal?.aborted) break

      // AI SDK may emit reasoning-part-finish; types may not include it yet
      const partType = (part as { type: string }).type
      if (partType === "reasoning-part-finish") continue

      // Some OpenAI-compatible gateways include reasoning fields on non-reasoning part types.
      // Emit these as reasoning_delta so Thought blocks are preserved in UI.
      const hasNativeReasoningType =
        partType === "reasoning-start" ||
        partType === "reasoning_start" ||
        partType === "reasoning" ||
        partType === "reasoning-delta" ||
        partType === "reasoning_delta"
      if (!hasNativeReasoningType) {
        const implicitReasoning = extractReasoningDelta(part as Record<string, unknown>, false)
        if (implicitReasoning) {
          if (!thoughtOpen) {
            currentReasoningId = currentReasoningId ?? extractReasoningId(part as Record<string, unknown>) ?? "reasoning-0"
            yield {
              type: "reasoning_start",
              reasoningId: currentReasoningId,
              providerMetadata: extractProviderMetadata(part as Record<string, unknown>),
            }
          }
          thoughtOpen = true
          yield {
            type: "reasoning_delta",
            reasoningId: currentReasoningId ?? undefined,
            delta: implicitReasoning,
            providerMetadata: extractProviderMetadata(part as Record<string, unknown>),
          }
        }
      }

      switch (partType) {
        case "text":
        case "text-delta":
          {
            const textDelta = extractTextDelta(part as Record<string, unknown>)
            for (const chunk of thinkTagParser.push(textDelta)) {
              if (chunk.kind === "reasoning") {
                if (!thoughtOpen) {
                  currentReasoningId = currentReasoningId ?? "reasoning-0"
                  yield { type: "reasoning_start", reasoningId: currentReasoningId }
                }
                thoughtOpen = true
                yield { type: "reasoning_delta", reasoningId: currentReasoningId ?? undefined, delta: chunk.text }
              } else {
                if (thoughtOpen) {
                  yield { type: "reasoning_end", reasoningId: currentReasoningId ?? undefined }
                  thoughtOpen = false
                  currentReasoningId = null
                }
                if (chunk.text) {
                  emittedVisibleText = true
                  sawAnyTextDelta = true
                  streamedTextBuffer += chunk.text
                  yield { type: "text_delta", delta: chunk.text }
                }
              }
            }
          }
          break

        case "raw": {
          // Some providers expose text/reasoning only via raw Responses-style events.
          const rawPart = part as { rawValue?: unknown; value?: unknown; raw?: unknown }
          const raw =
            asRecord(rawPart.rawValue) ?? asRecord(rawPart.value) ?? asRecord(rawPart.raw) ?? null
          if (raw) {
            const rawEventType = typeof raw["type"] === "string" ? String(raw["type"]) : ""
            const rawReasoning = extractReasoningDelta(raw, false)
            const isReasoningDeltaLike =
              rawEventType.includes("reasoning") ||
              rawEventType === "response.content_part.added" ||
              rawEventType === "response.output_item.added"
            const isReasoningDoneLike =
              rawEventType.endsWith(".done") &&
              (rawEventType.includes("reasoning") ||
                rawEventType === "response.content_part.done" ||
                rawEventType === "response.output_item.done")
            if (rawReasoning && (isReasoningDeltaLike || (isReasoningDoneLike && !sawAnyReasoningDelta))) {
              if (!thoughtOpen) {
                currentReasoningId = currentReasoningId ?? extractReasoningId(raw) ?? "reasoning-0"
                yield {
                  type: "reasoning_start",
                  reasoningId: currentReasoningId,
                  providerMetadata: extractProviderMetadata(raw),
                }
                thoughtOpen = true
              }
              sawAnyReasoningDelta = true
              yield {
                type: "reasoning_delta",
                reasoningId: currentReasoningId ?? undefined,
                delta: rawReasoning,
                providerMetadata: extractProviderMetadata(raw),
              }
            } else if (rawReasoning) {
              rawReasoningFallbackChunks.push(rawReasoning)
            }
            const rawText = extractTextDelta(raw)
            if (rawText) {
              const isTextDeltaLike =
                rawEventType.endsWith(".delta") ||
                rawEventType === "response.content_part.added" ||
                rawEventType === "response.output_item.added"
              const isTextDoneLike =
                rawEventType.endsWith(".done") ||
                rawEventType === "response.content_part.done" ||
                rawEventType === "response.output_item.done"
              if (isTextDeltaLike) {
                if (thoughtOpen) {
                  yield { type: "reasoning_end", reasoningId: currentReasoningId ?? undefined }
                  thoughtOpen = false
                  currentReasoningId = null
                }
                emittedVisibleText = true
                sawAnyTextDelta = true
                sawRawTextDelta = true
                streamedTextBuffer += rawText
                yield { type: "text_delta", delta: rawText }
              } else if (isTextDoneLike) {
                sawRawTextDone = true
                if (!sawAnyTextDelta && !sawRawTextDelta) {
                  if (thoughtOpen) {
                    yield { type: "reasoning_end", reasoningId: currentReasoningId ?? undefined }
                    thoughtOpen = false
                    currentReasoningId = null
                  }
                  emittedVisibleText = true
                  streamedTextBuffer += rawText
                  yield { type: "text_delta", delta: rawText }
                } else if (!sawRawTextDelta) {
                  rawTextFallbackChunks.push(rawText)
                }
              } else {
                rawTextFallbackChunks.push(rawText)
              }
            }
          }
          break
        }

        case "reasoning_start":
        case "reasoning-start":
          if (!thoughtOpen) {
            currentReasoningId = extractReasoningId(part as Record<string, unknown>) ?? currentReasoningId ?? "reasoning-0"
            yield {
              type: "reasoning_start",
              reasoningId: currentReasoningId,
              providerMetadata: extractProviderMetadata(part as Record<string, unknown>),
            }
            thoughtOpen = true
          }
          break

        case "reasoning":
        case "reasoning-delta":
        case "reasoning_delta":
          // Support both textDelta (streaming) and text (chunk) for reasoning/thinking models (OpenRouter, o1, DeepSeek R1, etc.)
          {
            if (!thoughtOpen) {
              currentReasoningId = extractReasoningId(part as Record<string, unknown>) ?? currentReasoningId ?? "reasoning-0"
              yield {
                type: "reasoning_start",
                reasoningId: currentReasoningId,
                providerMetadata: extractProviderMetadata(part as Record<string, unknown>),
              }
            }
            const delta = extractReasoningDelta(part as Record<string, unknown>, true)
            sawAnyReasoningDelta = true
            yield {
              type: "reasoning_delta",
              reasoningId: currentReasoningId ?? undefined,
              delta: delta ?? "",
              providerMetadata: extractProviderMetadata(part as Record<string, unknown>),
            }
            thoughtOpen = true
          }
          break

        case "reasoning-end":
        case "reasoning_end":
          yield {
            type: "reasoning_end",
            reasoningId: extractReasoningId(part as Record<string, unknown>) ?? currentReasoningId ?? undefined,
            providerMetadata: extractProviderMetadata(part as Record<string, unknown>),
          }
          thoughtOpen = false
          currentReasoningId = null
          break

        case "tool-call": {
          if (thoughtOpen) {
            yield { type: "reasoning_end", reasoningId: currentReasoningId ?? undefined }
            thoughtOpen = false
            currentReasoningId = null
          }
          const toolPart = part as {
            toolName?: string
            args?: Record<string, unknown>
            toolCallId?: string
          }
          let name = toolPart.toolName
          let args = toolPart.args as Record<string, unknown> | undefined
          // Kilo may return "ListDirectory"; gateway/CLI often send list_dir with paths[] or paths[0] undefined. Normalize to List with path only.
          if (
            name === "List" ||
            name === "list_dir" ||
            name === "ListDirectory" ||
            name === "list_directory"
          ) {
            name = "List"
            const raw = args && typeof args === "object" ? args : {}
            const pathVal =
              typeof raw.path === "string" && raw.path.length > 0
                ? raw.path
                : Array.isArray(raw.paths) && raw.paths.length > 0 && typeof raw.paths[0] === "string"
                  ? raw.paths[0]
                  : "."
            args = {
              path: pathVal,
              ignore: raw.ignore,
              recursive: raw.recursive,
              include: raw.include,
              max_entries: raw.max_entries,
              task_progress: raw.task_progress,
            }
          }
          yield {
            type: "tool_call",
            toolCallId: toolPart.toolCallId ?? "",
            toolName: name,
            toolInput: args ?? {},
          }
          break
        }

        case "finish": {
          sawFinishEvent = true
          const finishPart = part as { finishReason?: LLMStreamEvent["finishReason"] }
          for (const chunk of thinkTagParser.flush()) {
            if (chunk.kind === "reasoning") {
              if (!thoughtOpen) {
                currentReasoningId = currentReasoningId ?? "reasoning-0"
                yield { type: "reasoning_start", reasoningId: currentReasoningId }
                thoughtOpen = true
              }
              yield { type: "reasoning_delta", reasoningId: currentReasoningId ?? undefined, delta: chunk.text }
            } else {
              if (thoughtOpen) {
                yield { type: "reasoning_end", reasoningId: currentReasoningId ?? undefined }
                thoughtOpen = false
                currentReasoningId = null
              }
              yield { type: "text_delta", delta: chunk.text }
            }
          }

          // Fallback for providers that complete without explicit text-delta events.
          if (!sawAnyReasoningDelta && rawReasoningFallbackChunks.length > 0) {
            if (!thoughtOpen) {
              currentReasoningId = currentReasoningId ?? "reasoning-0"
              yield { type: "reasoning_start", reasoningId: currentReasoningId }
              thoughtOpen = true
            }
            const fallbackReasoning = rawReasoningFallbackChunks.join("")
            if (fallbackReasoning.trim().length > 0) {
              yield {
                type: "reasoning_delta",
                reasoningId: currentReasoningId ?? undefined,
                delta: fallbackReasoning,
              }
              sawAnyReasoningDelta = true
            }
          }

          // Fallback for providers that complete without explicit text-delta events.
          if (!emittedVisibleText) {
            const directText = await result.text.catch(() => "")
            const fallbackText =
              typeof directText === "string" && directText.trim().length > 0
                ? directText
                : rawTextFallbackChunks.join("")
            if (fallbackText.trim().length > 0) {
              if (thoughtOpen) {
                yield { type: "reasoning_end", reasoningId: currentReasoningId ?? undefined }
                thoughtOpen = false
                currentReasoningId = null
              }
              emittedVisibleText = true
              streamedTextBuffer += fallbackText
              yield { type: "text_delta", delta: fallbackText }
            }
          }

          if (thoughtOpen) {
            yield { type: "reasoning_end", reasoningId: currentReasoningId ?? undefined }
            thoughtOpen = false
            currentReasoningId = null
          }
          const usage = result.usage
          const usageData = await usage.catch(() => null)
          yield {
            type: "finish",
            finishReason: finishPart.finishReason ?? "stop",
            usage: {
              inputTokens: usageData?.promptTokens ?? 0,
              outputTokens: usageData?.completionTokens ?? 0,
            },
          }
          break
        }

        case "error":
          {
            const errPart = part as { error?: unknown }
            yield {
              type: "error",
              error: errPart.error instanceof Error ? errPart.error : new Error(String(errPart.error)),
            }
          }
          break
      }
    }

    if (!sawFinishEvent && !opts.signal?.aborted) {
      // Some gateways close stream without explicit finish event.
      for (const chunk of thinkTagParser.flush()) {
        if (chunk.kind === "reasoning") {
          if (!thoughtOpen) {
            currentReasoningId = currentReasoningId ?? "reasoning-0"
            yield { type: "reasoning_start", reasoningId: currentReasoningId }
            thoughtOpen = true
          }
          yield { type: "reasoning_delta", reasoningId: currentReasoningId ?? undefined, delta: chunk.text }
        } else if (chunk.text) {
          if (thoughtOpen) {
            yield { type: "reasoning_end", reasoningId: currentReasoningId ?? undefined }
            thoughtOpen = false
            currentReasoningId = null
          }
          emittedVisibleText = true
          streamedTextBuffer += chunk.text
          yield { type: "text_delta", delta: chunk.text }
        }
      }

      if (!sawAnyReasoningDelta && rawReasoningFallbackChunks.length > 0) {
        if (!thoughtOpen) {
          currentReasoningId = currentReasoningId ?? "reasoning-0"
          yield { type: "reasoning_start", reasoningId: currentReasoningId }
          thoughtOpen = true
        }
        const fallbackReasoning = rawReasoningFallbackChunks.join("")
        if (fallbackReasoning.trim().length > 0) {
          yield {
            type: "reasoning_delta",
            reasoningId: currentReasoningId ?? undefined,
            delta: fallbackReasoning,
          }
          sawAnyReasoningDelta = true
        }
      }

      if (!emittedVisibleText) {
        const directText = await result.text.catch(() => "")
        const fallbackText =
          typeof directText === "string" && directText.trim().length > 0
            ? directText
            : rawTextFallbackChunks.join("")
        if (fallbackText.trim().length > 0 && fallbackText.trim() !== streamedTextBuffer.trim()) {
          if (thoughtOpen) {
            yield { type: "reasoning_end", reasoningId: currentReasoningId ?? undefined }
            thoughtOpen = false
            currentReasoningId = null
          }
          emittedVisibleText = true
          streamedTextBuffer += fallbackText
          yield { type: "text_delta", delta: fallbackText }
        }
      }

      if (thoughtOpen) {
        yield { type: "reasoning_end", reasoningId: currentReasoningId ?? undefined }
      }

      const usage = result.usage
      const usageData = await usage.catch(() => null)
      yield {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: usageData?.promptTokens ?? 0,
          outputTokens: usageData?.completionTokens ?? 0,
        },
      }
    }
  }

  async generateStructured<T>(opts: GenerateOptions<T>): Promise<T> {
    return generateStructuredWithFallback(this, opts)
  }
}

function extractTextDelta(part: Record<string, unknown>): string {
  const maybeOutputText = part["output_text"]
  if (typeof maybeOutputText === "string") return maybeOutputText

  const type = typeof part["type"] === "string" ? String(part["type"]) : ""
  if (type === "response.output_text.done" || type === "response.text.done") {
    const doneText =
      (typeof part["text"] === "string" && part["text"]) ||
      (typeof part["output_text"] === "string" && part["output_text"]) ||
      (typeof part["delta"] === "string" && part["delta"]) ||
      ""
    if (doneText) return doneText
  }

  if (type === "response.content_part.added" || type === "response.content_part.done") {
    const partObj = asRecord(part["part"])
    if (partObj) {
      const contentType = typeof partObj["type"] === "string" ? String(partObj["type"]) : ""
      if (contentType === "text" || contentType === "output_text") {
        const partText =
          (typeof partObj["text"] === "string" && partObj["text"]) ||
          (asRecord(partObj["text"]) && typeof asRecord(partObj["text"])?.["value"] === "string"
            ? String(asRecord(partObj["text"])?.["value"])
            : "") ||
          ""
        if (partText) return partText
      }
    }
  }

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    const itemObj = asRecord(part["item"])
    if (itemObj) {
      const direct =
        (typeof itemObj["text"] === "string" && itemObj["text"]) ||
        (typeof itemObj["output_text"] === "string" && itemObj["output_text"]) ||
        ""
      if (direct) return direct
      const contentArr = itemObj["content"]
      if (Array.isArray(contentArr)) {
        for (const entry of contentArr) {
          const block = asRecord(entry)
          if (!block) continue
          const blockType = typeof block["type"] === "string" ? String(block["type"]) : ""
          if ((blockType === "text" || blockType === "output_text") && typeof block["text"] === "string") {
            return block["text"] as string
          }
        }
      }
    }
  }

  const response = asRecord(part["response"])
  const responseOutput = response?.["output"]
  if (Array.isArray(responseOutput)) {
    for (const outputItem of responseOutput) {
      const item = asRecord(outputItem)
      if (!item) continue
      if ((item["type"] === "text" || item["type"] === "output_text") && Array.isArray(item["content"])) {
        for (const contentBlock of item["content"] as unknown[]) {
          const content = asRecord(contentBlock)
          if (!content) continue
          if ((content["type"] === "text" || content["type"] === "output_text") && typeof content["text"] === "string") {
            return content["text"] as string
          }
        }
      }
    }
  }

  const deltaObj = asRecord(part["delta"])
  if (deltaObj) {
    const deltaContent =
      (typeof deltaObj["content"] === "string" && deltaObj["content"]) ||
      (typeof deltaObj["text"] === "string" && deltaObj["text"]) ||
      (typeof deltaObj["output_text"] === "string" && deltaObj["output_text"]) ||
      ""
    if (deltaContent) return deltaContent
  }

  const choices = asRecordArray(part["choices"])
  for (const choice of choices) {
    const choiceDelta = asRecord(choice["delta"])
    if (!choiceDelta) continue
    const choiceText =
      (typeof choiceDelta["content"] === "string" && choiceDelta["content"]) ||
      (typeof choiceDelta["text"] === "string" && choiceDelta["text"]) ||
      ""
    if (choiceText) return choiceText
  }

  const textDelta = part["textDelta"]
  if (typeof textDelta === "string") return textDelta
  const delta = part["delta"]
  if (typeof delta === "string") return delta
  const text = part["text"]
  if (typeof text === "string") return text
  return ""
}

function extractReasoningDelta(part: Record<string, unknown>, allowTextFallback: boolean): string {
  const direct = pickReasoningString(part, allowTextFallback)
  if (direct) return direct

  const deltaObj = asRecord(part["delta"])
  if (deltaObj) {
    const nestedDelta = pickReasoningString(deltaObj, allowTextFallback)
    if (nestedDelta) return nestedDelta
  }

  const openAICompatible = extractOpenAICompatibleReasoning(part, allowTextFallback)
  if (openAICompatible) return openAICompatible

  const providerMetadata = asRecord(part["providerMetadata"])
  if (providerMetadata) {
    for (const entry of Object.values(providerMetadata)) {
      const obj = asRecord(entry)
      if (!obj) continue
      const nested = pickReasoningString(obj, allowTextFallback)
      if (nested) return nested
    }
  }

  const deep = findReasoningStringDeep(part, allowTextFallback)
  if (deep) return deep

  return ""
}

function pickReasoningString(obj: Record<string, unknown>, allowTextFallback: boolean): string {
  const keys = [
    "reasoning",
    "reasoningText",
    "reasoning_text",
    "reasoningDetails",
    "reasoning_details",
    "reasoningContent",
    "reasoning_content",
    "reasoningSummary",
    "reasoning_summary",
    "thinking",
    "thinkingText",
    "thinking_text",
    "thought",
    "thoughts",
    "summary",
    "reasoningSummaryText",
    "reasoning_summary_text",
  ]
  if (allowTextFallback) keys.push("textDelta", "text")
  for (const key of keys) {
    const val = obj[key]
    const extracted = stringifyReasoningValue(val)
    if (extracted) return extracted
  }
  return ""
}

function stringifyReasoningValue(val: unknown): string {
  if (typeof val === "string" && val.length > 0) return val
  if (Array.isArray(val)) {
    const combined = val
      .map((entry) => stringifyReasoningValue(entry))
      .filter((entry) => entry.length > 0)
      .join("")
    return combined
  }
  const obj = asRecord(val)
  if (!obj) return ""
  const direct =
    (typeof obj["text"] === "string" && obj["text"]) ||
    (typeof obj["reasoning"] === "string" && obj["reasoning"]) ||
    (typeof obj["reasoning_text"] === "string" && obj["reasoning_text"]) ||
    (typeof obj["reasoning_content"] === "string" && obj["reasoning_content"]) ||
    (typeof obj["reasoning_summary"] === "string" && obj["reasoning_summary"]) ||
    (typeof obj["thinking"] === "string" && obj["thinking"]) ||
    (typeof obj["thought"] === "string" && obj["thought"]) ||
    ""
  if (direct) return direct
  const typedReasoning =
    (() => {
      const type = typeof obj["type"] === "string" ? obj["type"].toLowerCase() : ""
      if (!type.includes("reasoning") && !type.includes("thinking") && !type.includes("thought") && !type.includes("summary")) {
        return ""
      }
      return (
        (typeof obj["content"] === "string" && obj["content"]) ||
        (typeof obj["summary"] === "string" && obj["summary"]) ||
        (asRecord(obj["text"]) && typeof asRecord(obj["text"])?.["value"] === "string"
          ? String(asRecord(obj["text"])?.["value"])
          : "")
      )
    })()
  if (typedReasoning) return typedReasoning
  const contentBlocks =
    extractReasoningFromTypedBlocks(obj["content"]) ||
    extractReasoningFromTypedBlocks(obj["parts"]) ||
    extractReasoningFromTypedBlocks(obj["details"])
  if (contentBlocks) return contentBlocks
  const parts =
    stringifyReasoningValue(obj["reasoning_details"]) ||
    stringifyReasoningValue(obj["reasoningDetails"]) ||
    stringifyReasoningValue(obj["thoughts"])
  if (parts) return parts
  const nestedTyped = stringifyReasoningValue(obj["part"]) || stringifyReasoningValue(obj["item"])
  if (nestedTyped) return nestedTyped
  const nestedDelta = stringifyReasoningValue(obj["delta"])
  if (nestedDelta) return nestedDelta
  return ""
}

function extractReasoningFromTypedBlocks(value: unknown): string {
  if (!Array.isArray(value)) return ""
  const chunks: string[] = []
  for (const entry of value) {
    const obj = asRecord(entry)
    if (!obj) continue
    const type = typeof obj["type"] === "string" ? obj["type"].toLowerCase() : ""
    const isReasoningType =
      type.includes("reasoning") ||
      type.includes("thinking") ||
      type.includes("thought") ||
      type.includes("summary")
    const isThoughtFlag = obj["thought"] === true
    if (!isReasoningType && !isThoughtFlag) continue
    const blockText =
      (typeof obj["text"] === "string" && obj["text"]) ||
      (typeof obj["content"] === "string" && obj["content"]) ||
      (typeof obj["summary"] === "string" && obj["summary"]) ||
      (typeof obj["reasoning"] === "string" && obj["reasoning"]) ||
      ""
    if (blockText) chunks.push(blockText)
  }
  return chunks.join("")
}

function extractOpenAICompatibleReasoning(part: Record<string, unknown>, allowTextFallback: boolean): string {
  const choices = asRecordArray(part["choices"])
  for (const choice of choices) {
    const delta = asRecord(choice["delta"])
    if (!delta) continue
    const chunk =
      stringifyReasoningValue(delta["reasoning"]) ||
      stringifyReasoningValue(delta["reasoning_text"]) ||
      stringifyReasoningValue(delta["reasoning_content"]) ||
      stringifyReasoningValue(delta["reasoning_details"]) ||
      stringifyReasoningValue(delta["thinking"]) ||
      (allowTextFallback ? stringifyReasoningValue(delta["content"]) : "")
    if (chunk) return chunk
  }
  return ""
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null
  return value as Record<string, unknown>
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
}

function extractReasoningId(part: Record<string, unknown>): string | undefined {
  const direct =
    (typeof part["id"] === "string" && part["id"]) ||
    (typeof part["reasoningId"] === "string" && part["reasoningId"]) ||
    (typeof part["reasoning_id"] === "string" && part["reasoning_id"]) ||
    (typeof part["itemId"] === "string" && part["itemId"]) ||
    (typeof part["item_id"] === "string" && part["item_id"]) ||
    undefined
  if (direct) return direct
  const delta = asRecord(part["delta"])
  if (delta) {
    return (
      (typeof delta["id"] === "string" && delta["id"]) ||
      (typeof delta["reasoningId"] === "string" && delta["reasoningId"]) ||
      (typeof delta["reasoning_id"] === "string" && delta["reasoning_id"]) ||
      undefined
    )
  }
  return undefined
}

function extractProviderMetadata(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const metadata = asRecord(part["providerMetadata"])
  if (metadata) return metadata
  const delta = asRecord(part["delta"])
  if (delta) {
    const nested = asRecord(delta["providerMetadata"])
    if (nested) return nested
  }
  return undefined
}

function findReasoningStringDeep(
  value: unknown,
  allowTextFallback: boolean,
  seen: Set<unknown> = new Set(),
  depth = 0
): string {
  if (depth > 6 || value == null) return ""
  if (typeof value !== "object") return ""
  if (seen.has(value)) return ""
  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findReasoningStringDeep(item, allowTextFallback, seen, depth + 1)
      if (nested) return nested
    }
    return ""
  }

  const obj = value as Record<string, unknown>
  const direct = pickReasoningString(obj, allowTextFallback)
  if (direct) return direct

  for (const nestedValue of Object.values(obj)) {
    const nested = findReasoningStringDeep(nestedValue, allowTextFallback, seen, depth + 1)
    if (nested) return nested
  }

  return ""
}

function buildAISDKMessages(
  messages: StreamOptions["messages"],
  providerName: string,
  modelId: string,
  reasoningHistoryMode: ReasoningHistoryMode,
): Parameters<typeof streamText>[0]["messages"] {
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
        case "reasoning":
          parts.push({ type: "reasoning", text: part.text })
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

  const interleavedField = resolveInterleavedReasoningField(reasoningHistoryMode, modelId)
  normalizeReasoningHistoryForSdkMessages(result as Record<string, unknown>[], {
    anthropicPipeline: isAnthropicLikeMessagesPipeline(providerName),
    interleavedField,
  })

  if (supportsPromptCacheHints(providerName)) {
    addPromptCacheBreakpoints(result)
  }

  return result
}

/** Strip empty text/reasoning parts from array content (Claude / Bedrock). */
function isAnthropicLikeMessagesPipeline(providerName: string): boolean {
  const p = providerName.toLowerCase()
  return p === "anthropic" || p === "bedrock"
}

function supportsPromptCacheHints(providerName: string): boolean {
  const p = providerName.toLowerCase()
  return (
    p === "anthropic" ||
    p === "openrouter" ||
    p === "openai-compatible" ||
    p === "bedrock" ||
    p === "minimax"
  )
}

function addPromptCacheBreakpoints(messages: Parameters<typeof streamText>[0]["messages"]): void {
  if (!messages) return
  const users = messages.filter((m) => m.role === "user")
  const targets = users.slice(-2)
  for (const msg of targets) {
    if (typeof msg.content === "string") {
      const text = msg.content.trim().length > 0 ? msg.content : "..."
      msg.content = [{ type: "text", text, cache_control: { type: "ephemeral" } } as any]
      continue
    }
    if (!Array.isArray(msg.content)) continue
    let lastTextIdx = -1
    for (let i = msg.content.length - 1; i >= 0; i--) {
      const part = msg.content[i] as { type?: string } | undefined
      if (part?.type === "text") {
        lastTextIdx = i
        break
      }
    }
    if (lastTextIdx === -1) {
      msg.content.push({ type: "text", text: "...", cache_control: { type: "ephemeral" } } as any)
      continue
    }
    const block = msg.content[lastTextIdx] as unknown as Record<string, unknown>
    block["cache_control"] = { type: "ephemeral" }
  }
}

function withPromptCachingProviderOptions(
  providerOptions: Record<string, unknown> | undefined,
  providerName: string,
  promptCacheKey: string | undefined
): Record<string, unknown> | undefined {
  const base = providerOptions ? { ...providerOptions } : {}
  const cacheHints: Record<string, unknown> = {}

  const lower = providerName.toLowerCase()
  if (lower === "anthropic") {
    cacheHints["anthropic"] = { cacheControl: { type: "ephemeral" } }
  }
  if (lower === "openrouter") {
    cacheHints["openrouter"] = {
      cacheControl: { type: "ephemeral" },
      ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    }
  }
  if (lower === "openai-compatible") {
    cacheHints["openaiCompatible"] = { cache_control: { type: "ephemeral" } }
  }
  if (lower === "bedrock") {
    cacheHints["bedrock"] = { cachePoint: { type: "default" } }
  }
  if (lower === "minimax") {
    cacheHints["anthropic"] = { cacheControl: { type: "ephemeral" } }
  }
  if (promptCacheKey) {
    cacheHints["gateway"] = { caching: "auto" }
  }

  if (Object.keys(cacheHints).length === 0) return providerOptions
  return deepMergeObjects(base, cacheHints)
}

function deepMergeObjects(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...left }
  for (const [key, val] of Object.entries(right)) {
    const existing = out[key]
    if (
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMergeObjects(
        existing as Record<string, unknown>,
        val as Record<string, unknown>
      )
    } else {
      out[key] = val
    }
  }
  return out
}

type ThinkChunk = { kind: "text" | "reasoning"; text: string }

function createThinkTagParser(): { push: (delta: string) => ThinkChunk[]; flush: () => ThinkChunk[] } {
  const OPEN_TAGS = ["<think>", "<thinking>", "<reasoning>"]
  const CLOSE_TAGS = ["</think>", "</thinking>", "</reasoning>"]
  const MAX_OPEN_TAG_LEN = Math.max(...OPEN_TAGS.map((t) => t.length))
  const MAX_CLOSE_TAG_LEN = Math.max(...CLOSE_TAGS.map((t) => t.length))

  let buffer = ""
  let inThink = false

  const maybePush = (out: ThinkChunk[], kind: ThinkChunk["kind"], text: string) => {
    if (!text) return
    out.push({ kind, text })
  }

  const findFirstTag = (haystackLower: string, tags: string[]): { index: number; tag: string } | null => {
    let bestIndex = -1
    let bestTag = ""
    for (const tag of tags) {
      const idx = haystackLower.indexOf(tag)
      if (idx !== -1 && (bestIndex === -1 || idx < bestIndex)) {
        bestIndex = idx
        bestTag = tag
      }
    }
    return bestIndex === -1 ? null : { index: bestIndex, tag: bestTag }
  }

  const push = (delta: string): ThinkChunk[] => {
    if (!delta) return []
    const out: ThinkChunk[] = []
    buffer += delta

    while (buffer.length > 0) {
      const lower = buffer.toLowerCase()
      if (inThink) {
        const close = findFirstTag(lower, CLOSE_TAGS)
        if (!close) {
          const keep = Math.min(buffer.length, MAX_CLOSE_TAG_LEN - 1)
          const emitLen = buffer.length - keep
          if (emitLen > 0) {
            maybePush(out, "reasoning", buffer.slice(0, emitLen))
            buffer = buffer.slice(emitLen)
          }
          break
        }
        if (close.index > 0) maybePush(out, "reasoning", buffer.slice(0, close.index))
        buffer = buffer.slice(close.index + close.tag.length)
        inThink = false
        continue
      }

      const open = findFirstTag(lower, OPEN_TAGS)
      if (!open) {
        const keep = Math.min(buffer.length, MAX_OPEN_TAG_LEN - 1)
        const emitLen = buffer.length - keep
        if (emitLen > 0) {
          maybePush(out, "text", buffer.slice(0, emitLen))
          buffer = buffer.slice(emitLen)
        }
        break
      }
      if (open.index > 0) maybePush(out, "text", buffer.slice(0, open.index))
      buffer = buffer.slice(open.index + open.tag.length)
      inThink = true
    }

    return out
  }

  const flush = (): ThinkChunk[] => {
    if (!buffer) return []
    const out: ThinkChunk[] = []
    maybePush(out, inThink ? "reasoning" : "text", buffer)
    buffer = ""
    return out
  }

  return { push, flush }
}

function providerOptionsRequestsReasoning(providerOptions: Record<string, unknown> | undefined): boolean {
  if (!providerOptions) return false
  const scan = (value: unknown, depth = 0): boolean => {
    if (depth > 6 || value == null) return false
    if (typeof value === "boolean") return value
    if (typeof value === "string") {
      const lower = value.toLowerCase()
      if (["none", "off", "false", "disabled"].includes(lower)) return false
      if (["minimal", "low", "medium", "high", "max", "xhigh", "enabled", "adaptive", "true"].includes(lower)) return true
      return false
    }
    if (Array.isArray(value)) return value.some((item) => scan(item, depth + 1))
    if (typeof value !== "object") return false
    const record = value as Record<string, unknown>
    for (const [key, nested] of Object.entries(record)) {
      const normalized = key.toLowerCase()
      if (
        normalized.includes("reasoningeffort") ||
        normalized === "reasoning_effort" ||
        normalized === "reasoning" ||
        normalized === "thinking" ||
        normalized === "enable_thinking" ||
        normalized === "include_reasoning"
      ) {
        if (scan(nested, depth + 1)) return true
      }
      if (scan(nested, depth + 1)) return true
    }
    return false
  }
  return scan(providerOptions)
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
    msg.includes("enotfound") ||
    msg.includes("ehostunreach") ||
    msg.includes("network") ||
    msg.includes("socket") ||
    msg.includes("fetch failed")
  )
}

function getRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null
  const rawHeaders =
    (err as { headers?: unknown }).headers ??
    (err as { response?: { headers?: unknown } }).response?.headers

  const retryAfterRaw = getHeaderValue(rawHeaders, "retry-after")
  if (!retryAfterRaw) return null
  const retryAfter = Array.isArray(retryAfterRaw) ? retryAfterRaw[0] : retryAfterRaw
  if (!retryAfter) return null

  const seconds = Number.parseInt(String(retryAfter), 10)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000
  }

  const asDate = Date.parse(String(retryAfter))
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now())
  }
  return null
}

function getHeaderValue(
  headers: unknown,
  key: string
): string | string[] | undefined {
  if (!headers) return undefined
  const lowerKey = key.toLowerCase()
  const HeadersCtor = (globalThis as { Headers?: { new (...args: unknown[]): { get(name: string): string | null } } }).Headers
  if (typeof HeadersCtor === "function" && headers instanceof HeadersCtor) {
    const val = headers.get(lowerKey)
    return val ?? undefined
  }
  if (typeof headers === "object") {
    const asRecord = headers as Record<string, unknown>
    const direct = asRecord[key] ?? asRecord[lowerKey] ?? asRecord[key.toUpperCase()]
    if (typeof direct === "string" || Array.isArray(direct)) {
      return direct as string | string[]
    }
  }
  return undefined
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
