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
    const initialDelay = opts.initialRetryDelayMs ?? DEFAULT_INITIAL_DELAY
    const maxDelay = opts.maxRetryDelayMs ?? DEFAULT_MAX_DELAY
    const retryableStatuses = new Set(opts.retryOnStatus ?? DEFAULT_RETRYABLE_STATUS)
    const providerOptionsCandidates = normalizeProviderOptionsCandidates(
      opts.providerOptionsCandidates,
      opts.providerOptions
    )
    let providerOptionsIndex = 0

    while (true) {
      attempt++
      try {
        const activeProviderOptions = providerOptionsCandidates[providerOptionsIndex]
        yield* this._streamOnce(
          opts,
          messages,
          tools,
          activeProviderOptions
        )
        return
      } catch (err) {
        if (opts.signal?.aborted) throw err
        if (
          providerOptionsCandidates.length > 0 &&
          providerOptionsIndex < providerOptionsCandidates.length - 1 &&
          looksLikeUnsupportedProviderOptionsError(err)
        ) {
          providerOptionsIndex++
          attempt--
          continue
        }
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
    const thinkTagParser = createThinkTagParser()
    const result = streamText({
      model: this.model,
      system: opts.systemPrompt,
      messages,
      tools,
      maxTokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature,
      abortSignal: opts.signal,
      maxSteps: 1, // We handle multi-step manually in agentLoop
      ...(providerOptions && Object.keys(providerOptions).length > 0
        ? { providerOptions: providerOptions as any }
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
        partType === "reasoning" ||
        partType === "reasoning-delta" ||
        partType === "reasoning_delta"
      if (!hasNativeReasoningType) {
        const implicitReasoning = extractReasoningDelta(part as Record<string, unknown>, false)
        if (implicitReasoning) {
          yield { type: "reasoning_delta", delta: implicitReasoning }
        }
      }

      switch (partType) {
        case "text-delta":
          {
            const textDelta = extractTextDelta(part as Record<string, unknown>)
            for (const chunk of thinkTagParser.push(textDelta)) {
              if (chunk.kind === "reasoning") {
                yield { type: "reasoning_delta", delta: chunk.text }
              } else {
                yield { type: "text_delta", delta: chunk.text }
              }
            }
          }
          break

        case "reasoning":
        case "reasoning-delta":
        case "reasoning_delta":
          // Support both textDelta (streaming) and text (chunk) for reasoning/thinking models (OpenRouter, o1, DeepSeek R1, etc.)
          {
            const delta = extractReasoningDelta(part as Record<string, unknown>, true)
            if (delta) {
              yield {
                type: "reasoning_delta",
                delta,
              }
            }
          }
          break

        case "reasoning-end":
        case "reasoning_end":
          yield { type: "reasoning_end" }
          break

        case "tool-call": {
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
          const finishPart = part as { finishReason?: LLMStreamEvent["finishReason"] }
          for (const chunk of thinkTagParser.flush()) {
            if (chunk.kind === "reasoning") {
              yield { type: "reasoning_delta", delta: chunk.text }
            } else {
              yield { type: "text_delta", delta: chunk.text }
            }
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
  }

  async generateStructured<T>(opts: GenerateOptions<T>): Promise<T> {
    return generateStructuredWithFallback(this, opts)
  }
}

function extractTextDelta(part: Record<string, unknown>): string {
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
  const parts =
    stringifyReasoningValue(obj["reasoning_details"]) ||
    stringifyReasoningValue(obj["reasoningDetails"]) ||
    stringifyReasoningValue(obj["thoughts"])
  if (parts) return parts
  const nestedDelta = stringifyReasoningValue(obj["delta"])
  if (nestedDelta) return nestedDelta
  return ""
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null
  return value as Record<string, unknown>
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

function normalizeProviderOptionsCandidates(
  explicitCandidates: StreamOptions["providerOptionsCandidates"] | undefined,
  singleProviderOptions: StreamOptions["providerOptions"] | undefined
): Array<Record<string, unknown> | undefined> {
  if (Array.isArray(explicitCandidates) && explicitCandidates.length > 0) {
    return explicitCandidates
  }
  if (singleProviderOptions && Object.keys(singleProviderOptions).length > 0) {
    return [singleProviderOptions, undefined]
  }
  return [undefined]
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

function looksLikeUnsupportedProviderOptionsError(err: unknown): boolean {
  const msg = String(err).toLowerCase()
  const mentionsReasoning =
    msg.includes("reasoning_effort") ||
    msg.includes("reasoningeffort") ||
    msg.includes("reasoning") ||
    msg.includes("thinking")
  const indicatesUnsupported =
    msg.includes("unsupported") ||
    msg.includes("unknown") ||
    msg.includes("unrecognized") ||
    msg.includes("invalid") ||
    msg.includes("not allowed") ||
    msg.includes("not supported") ||
    msg.includes("unexpected")
  return mentionsReasoning && indicatesUnsupported
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
