import { generateObject } from "ai"
import type { z } from "zod"
import type { LLMClient, GenerateOptions } from "./types.js"

/**
 * Map of providers/models that support native JSON schema structured output.
 * Key: "{provider}/{model_prefix}" or "{provider}/*"
 */
const STRUCTURED_OUTPUT_SUPPORT: Record<string, boolean | ((modelId: string) => boolean)> = {
  "anthropic/*": true,
  "openai/gpt-4o": true,
  "openai/gpt-4o-mini": true,
  "openai/gpt-4-turbo": true,
  "openai/gpt-4.1": true,
  "openai/gpt-5": true,
  "openai/o1": true,
  "openai/o3": true,
  "google/gemini-2": true,
  "google/gemini-1.5-pro": false,
}

export function supportsStructuredOutput(provider: string, modelId: string): boolean {
  const wildcardKey = `${provider}/*`
  if (wildcardKey in STRUCTURED_OUTPUT_SUPPORT) {
    const val = STRUCTURED_OUTPUT_SUPPORT[wildcardKey]
    return typeof val === "function" ? val(modelId) : Boolean(val)
  }
  // Check prefixes
  for (const [key, val] of Object.entries(STRUCTURED_OUTPUT_SUPPORT)) {
    if (key.endsWith("/*")) continue
    if (modelId.startsWith(key.replace(`${provider}/`, ""))) {
      return typeof val === "function" ? val(modelId) : Boolean(val)
    }
  }
  return false
}

/**
 * Generate structured output, falling back to JSON extraction from text if needed.
 */
export async function generateStructuredWithFallback<T>(
  client: LLMClient,
  opts: GenerateOptions<T>
): Promise<T> {
  if (client.supportsStructuredOutput()) {
    try {
      const model = client.getModel()
      const result = await generateObject({
        model,
        schema: opts.schema as z.ZodType<T>,
        messages: opts.messages as Parameters<typeof generateObject>[0]["messages"],
        system: opts.systemPrompt,
        maxRetries: opts.maxRetries ?? 2,
      })
      return result.object
    } catch (err) {
      // Fall through to text-based extraction
      console.warn("[nexus] Structured output failed, falling back to text extraction:", err)
    }
  }

  // Fallback: stream text and extract JSON
  return extractJsonFromStream(client, opts)
}

async function extractJsonFromStream<T>(client: LLMClient, opts: GenerateOptions<T>): Promise<T> {
  const messages = [
    ...opts.messages,
    {
      role: "user" as const,
      content: "IMPORTANT: Your response must be valid JSON only, no markdown, no explanation. Start with { or [.",
    },
  ]

  let fullText = ""
  for await (const event of client.stream({
    messages,
    systemPrompt: opts.systemPrompt,
    signal: opts.signal,
    temperature: 0.1,
  })) {
    if (event.type === "text_delta" && event.delta) {
      fullText += event.delta
    }
    if (event.type === "finish") break
    if (event.type === "error" && event.error) throw event.error
  }

  // Extract JSON from response
  const jsonStr = extractJsonString(fullText)
  try {
    const parsed = JSON.parse(jsonStr)
    return opts.schema.parse(parsed) as T
  } catch (err) {
    throw new Error(`Failed to parse structured output: ${err}. Raw: ${fullText.slice(0, 200)}`)
  }
}

function extractJsonString(text: string): string {
  // Try <json>...</json> tags
  const tagMatch = text.match(/<json>([\s\S]*?)<\/json>/i)
  if (tagMatch?.[1]) return tagMatch[1].trim()

  // Try ```json...``` code blocks
  const codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (codeMatch?.[1]) return codeMatch[1].trim()

  // Try to find raw JSON object/array
  const objectMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/m)
  if (objectMatch?.[1]) return objectMatch[1].trim()

  return text.trim()
}
