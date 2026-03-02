import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

/** Exa MCP endpoint — no API key required (Kilo Code / OpenCode style). */
const EXA_MCP_URL = "https://mcp.exa.ai/mcp"

const EXA_WEB_SEARCH_TIMEOUT = 25_000
const EXA_CODE_SEARCH_TIMEOUT = 30_000

interface McpResponse {
  result?: {
    content?: Array<{ type: string; text: string }>
  }
}

function parseMcpSseResponse(responseText: string): string | null {
  const lines = responseText.split("\n")
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      try {
        const data = JSON.parse(line.slice(6)) as McpResponse
        if (data.result?.content?.length) {
          return data.result.content[0].text
        }
      } catch {
        // skip malformed lines
      }
    }
  }
  return null
}

// ─── Exa Web Search ─────────────────────────────────────────────────────────

const exaWebSearchSchema = z.object({
  query: z.string().describe("Web search query"),
  numResults: z.number().int().min(1).max(20).optional().describe("Number of results (default: 8)"),
  livecrawl: z
    .enum(["fallback", "preferred"])
    .optional()
    .describe("'fallback': live crawl as backup; 'preferred': prioritize live (default: fallback)"),
  type: z
    .enum(["auto", "fast", "deep"])
    .optional()
    .describe("'auto': balanced, 'fast': quick, 'deep': comprehensive (default: auto)"),
  contextMaxCharacters: z.number().int().positive().optional().describe("Max context chars for LLM (default: 10000)"),
  task_progress: z.string().optional(),
})

export const exaWebSearchTool: ToolDef<z.infer<typeof exaWebSearchSchema>> = {
  name: "exa_web_search",
  description: `Search the web via Exa AI — real-time web search, no API key required.
Use for: current events, recent docs, info beyond training data, verifying APIs/dependencies.
Supports live crawling and configurable result count. Today's date: use when searching for "latest" or "current" info.`,
  parameters: exaWebSearchSchema,
  readOnly: true,

  async execute({ query, numResults = 8, livecrawl = "fallback", type = "auto", contextMaxCharacters }, ctx: ToolContext) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), EXA_WEB_SEARCH_TIMEOUT)
    const onAbort = () => controller.abort()
    ctx.signal?.addEventListener?.("abort", onAbort)

    try {
      const response = await fetch(EXA_MCP_URL, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: {
              query,
              numResults,
              livecrawl,
              type,
              ...(contextMaxCharacters != null && { contextMaxCharacters }),
            },
          },
        }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      ctx.signal?.removeEventListener?.("abort", onAbort)

      if (!response.ok) {
        const errText = await response.text()
        return { success: false, output: `Exa web search error (${response.status}): ${errText}` }
      }

      const text = await response.text()
      const result = parseMcpSseResponse(text)
      if (result != null) {
        return {
          success: true,
          output: result,
          metadata: { query, numResults },
        }
      }
      return {
        success: true,
        output: "No search results found. Try a different query.",
        metadata: { query },
      }
    } catch (err) {
      clearTimeout(timeoutId)
      ctx.signal?.removeEventListener?.("abort", onAbort)
      if (err instanceof Error && err.name === "AbortError") {
        return { success: false, output: "Exa web search timed out." }
      }
      return { success: false, output: `Exa web search failed: ${(err as Error).message}` }
    }
  },
}

// ─── Exa Code Search ─────────────────────────────────────────────────────────

const exaCodeSearchSchema = z.object({
  query: z
    .string()
    .describe(
      "Search query for APIs, libraries, SDKs. E.g. 'React useState hook examples', 'Python pandas dataframe filter', 'Express.js middleware'"
    ),
  tokensNum: z
    .number()
    .int()
    .min(1000)
    .max(50000)
    .optional()
    .describe("Tokens to return (1000–50000, default: 5000). Lower for focused, higher for full docs."),
  task_progress: z.string().optional(),
})

export const exaCodeSearchTool: ToolDef<z.infer<typeof exaCodeSearchSchema>> = {
  name: "exa_code_search",
  description: `Get code/docs context via Exa Code API — no API key required.
Use for: library docs, SDK examples, API references, programming patterns.
Returns code snippets and documentation; adjust tokensNum for focused vs comprehensive context.`,
  parameters: exaCodeSearchSchema,
  readOnly: true,

  async execute({ query, tokensNum = 5000 }, ctx: ToolContext) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), EXA_CODE_SEARCH_TIMEOUT)
    const onAbort = () => controller.abort()
    ctx.signal?.addEventListener?.("abort", onAbort)

    try {
      const response = await fetch(EXA_MCP_URL, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "get_code_context_exa",
            arguments: { query, tokensNum },
          },
        }),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
      ctx.signal?.removeEventListener?.("abort", onAbort)

      if (!response.ok) {
        const errText = await response.text()
        return { success: false, output: `Exa code search error (${response.status}): ${errText}` }
      }

      const text = await response.text()
      const result = parseMcpSseResponse(text)
      if (result != null) {
        return {
          success: true,
          output: result,
          metadata: { query, tokensNum },
        }
      }
      return {
        success: true,
        output:
          "No code or documentation found. Try a different query, be more specific about the library or concept, or check spelling.",
        metadata: { query },
      }
    } catch (err) {
      clearTimeout(timeoutId)
      ctx.signal?.removeEventListener?.("abort", onAbort)
      if (err instanceof Error && err.name === "AbortError") {
        return { success: false, output: "Exa code search timed out." }
      }
      return { success: false, output: `Exa code search failed: ${(err as Error).message}` }
    }
  },
}
