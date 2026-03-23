/**
 * OpenRouter / some upstream models (e.g. x-ai Grok) occasionally emit SSE chunks where
 * `choices[0].index` is missing, while `index` appears under `choices[0].delta` instead.
 * @openrouter/ai-sdk-provider validates the OpenAI chat-completion chunk shape and fails with
 * Zod "choices.0.index required". Normalize before the SDK sees the JSON.
 */
function patchOpenAiChatCompletionChunk(chunk: unknown): void {
  if (chunk == null || typeof chunk !== "object") return
  const root = chunk as Record<string, unknown>
  const choices = root["choices"]
  if (!Array.isArray(choices)) return
  choices.forEach((choice, i) => {
    if (choice == null || typeof choice !== "object") return
    const c = choice as Record<string, unknown>
    if (typeof c["index"] === "number" && !Number.isNaN(c["index"])) return
    const delta = c["delta"]
    if (delta != null && typeof delta === "object") {
      const d = delta as Record<string, unknown>
      if (typeof d["index"] === "number" && !Number.isNaN(d["index"])) {
        c["index"] = d["index"]
        delete d["index"]
        return
      }
    }
    c["index"] = i
  })
}

function parseSseDataPayload(block: string): string | null {
  const lines = block.split("\n")
  const dataLines: string[] = []
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  return dataLines.join("\n")
}

/**
 * Returns a fetch that only transforms successful text/event-stream bodies.
 */
export function createOpenRouterStreamNormalizingFetch(
  baseFetch: typeof fetch = globalThis.fetch.bind(globalThis)
): typeof fetch {
  return async (input, init) => {
    const res = await baseFetch(input, init)
    const ct = res.headers.get("content-type") ?? ""
    if (!ct.includes("text/event-stream") || !res.body) {
      return res
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let carry = ""

    const out = new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (true) {
          const boundary = carry.indexOf("\n\n")
          if (boundary !== -1) {
            const rawBlock = carry.slice(0, boundary)
            carry = carry.slice(boundary + 2)
            const payload = parseSseDataPayload(rawBlock)
            if (payload != null && payload !== "[DONE]") {
              try {
                const obj = JSON.parse(payload) as unknown
                patchOpenAiChatCompletionChunk(obj)
                const fixed = JSON.stringify(obj)
                const lines = rawBlock.split("\n")
                const prefixLines = lines.filter((line) => line.length > 0 && !line.startsWith("data:"))
                const rebuilt =
                  (prefixLines.length ? `${prefixLines.join("\n")}\n` : "") + `data: ${fixed}\n\n`
                controller.enqueue(encoder.encode(rebuilt))
              } catch {
                controller.enqueue(encoder.encode(rawBlock + "\n\n"))
              }
            } else {
              controller.enqueue(encoder.encode(rawBlock + "\n\n"))
            }
            continue
          }

          const { done, value } = await reader.read()
          if (done) {
            if (carry.length > 0) {
              controller.enqueue(encoder.encode(carry))
            }
            controller.close()
            return
          }
          carry += decoder.decode(value, { stream: true })
        }
      },
    })

    return new Response(out, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}
