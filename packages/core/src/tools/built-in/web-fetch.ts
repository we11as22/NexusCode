import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"
import TurndownService from "turndown"

const MAX_CONTENT_BYTES = 100 * 1024 // 100 KB
const FETCH_TIMEOUT = 30_000

const schema = z.object({
  url: z.string().url().describe("URL to fetch"),
  max_length: z.number().int().positive().max(200000).optional().describe("Max content length in characters (default: 100000)"),
  task_progress: z.string().optional(),
})

export const webFetchTool: ToolDef<z.infer<typeof schema>> = {
  name: "WebFetch",
  description: `Fetch content from a URL via HTTP. HTML is converted to markdown; JSON/text returned as-is. Read-only.

When to use:
- Documentation, API specs, or URLs the user provided.
- Extracting text from public pages, reading static content, or checking external references.

When NOT to use:
- Do not guess or fabricate URLs; use only user-provided or tool-discovered URLs.
- Authenticated or private URLs (e.g. Google Docs, Confluence, Jira) — WebFetch will fail; use a specialized authenticated tool if available.
- Large binaries or non-text content; tool is text-oriented and caps response size.

Usage: URL must be fully-formed and valid. Timeout ~30s. When the response indicates a redirect to a different host, make a new WebFetch request with the redirect URL provided in the response. If an MCP-provided web fetch tool is available (e.g. mcp_web_fetch), prefer it when it may have fewer restrictions.`,
  parameters: schema,
  readOnly: true,

  async execute({ url, max_length }, _ctx: ToolContext) {
    const maxLen = max_length ?? MAX_CONTENT_BYTES

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT)

      const response = await fetch(url, {
        signal: controller.signal as any,
        headers: {
          "User-Agent": "NexusCode/1.0 (AI coding assistant)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8",
        },
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        return {
          success: false,
          output: `HTTP ${response.status} ${response.statusText}: ${url}`,
        }
      }

      const contentType = response.headers.get("content-type") ?? ""
      let text = await response.text()

      if (text.length > maxLen) {
        text = text.slice(0, maxLen) + `\n\n[... content truncated at ${maxLen} chars ...]`
      }

      // Convert HTML to markdown
      if (contentType.includes("text/html")) {
        text = htmlToMarkdown(text)
        if (text.length > maxLen) {
          text = text.slice(0, maxLen) + `\n\n[... truncated ...]`
        }
      }

      return {
        success: true,
        output: `URL: ${url}\nContent-Type: ${contentType}\n\n${text}`,
      }
    } catch (err: unknown) {
      const msg = (err as Error).message
      if (msg.includes("aborted") || msg.includes("timeout")) {
        return { success: false, output: `Request timed out for: ${url}` }
      }
      return { success: false, output: `Failed to fetch ${url}: ${msg}` }
    }
  },
}

function htmlToMarkdown(html: string): string {
  try {
    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    })
    return td.turndown(html)
  } catch {
    // Fallback: basic HTML stripping
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  }
}

const webSearchSchema = z.object({
  query: z.string().describe("Search query"),
  max_results: z.number().int().positive().max(10).optional().describe("Max results (default: 5)"),
  task_progress: z.string().optional(),
})

export const webSearchTool: ToolDef<z.infer<typeof webSearchSchema>> = {
  name: "WebSearch",
  description: `Search the web for real-time information (Brave or Serper). Returns titles, URLs, and snippets. Use WebFetch to read full pages. Requires BRAVE_API_KEY or SERPER_API_KEY.

When to use:
- Current docs, versions, or information beyond training data.
- Verifying APIs, dependencies, or recent changes.
- Questions about current events, technology updates, or topics that require recent information.

When NOT to use:
- Codebase questions: use CodebaseSearch or Grep.
- When the user already gave a URL: use WebFetch directly.

Usage: Be specific in the query; include version numbers or dates for technical queries. Account for "Today's date" in the Environment block — e.g. when searching for "latest docs", use the current year in the query. After using search results in your answer, include a "Sources:" section with markdown links to the relevant URLs (e.g. [Title](URL)).`,
  parameters: webSearchSchema,
  readOnly: true,

  async execute({ query, max_results }, _ctx: ToolContext) {
    const braveKey = process.env["BRAVE_API_KEY"]
    const serperKey = process.env["SERPER_API_KEY"]

    if (!braveKey && !serperKey) {
      return {
        success: false,
        output: "Web search requires BRAVE_API_KEY or SERPER_API_KEY environment variable.",
      }
    }

    const limit = max_results ?? 5

    if (braveKey) {
      return searchWithBrave(query, limit, braveKey)
    }
    return searchWithSerper(query, limit, serperKey!)
  },
}

async function searchWithBrave(query: string, limit: number, apiKey: string) {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-Subscription-Token": apiKey,
      },
    })

    if (!response.ok) {
      return { success: false, output: `Brave Search error: ${response.status}` }
    }

    const data = await response.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } }
    const results = data.web?.results ?? []

    if (results.length === 0) {
      return { success: true, output: `No results found for: "${query}"` }
    }

    const formatted = results
      .slice(0, limit)
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description ?? ""}`)
      .join("\n\n")

    return { success: true, output: `Search results for "${query}":\n\n${formatted}` }
  } catch (err) {
    return { success: false, output: `Brave search error: ${(err as Error).message}` }
  }
}

async function searchWithSerper(query: string, limit: number, apiKey: string) {
  try {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: query, num: limit }),
    })

    if (!response.ok) {
      return { success: false, output: `Serper error: ${response.status}` }
    }

    const data = await response.json() as { organic?: Array<{ title: string; link: string; snippet: string }> }
    const results = data.organic ?? []

    if (results.length === 0) {
      return { success: true, output: `No results found for: "${query}"` }
    }

    const formatted = results
      .slice(0, limit)
      .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.link}\n   ${r.snippet ?? ""}`)
      .join("\n\n")

    return { success: true, output: `Search results for "${query}":\n\n${formatted}` }
  } catch (err) {
    return { success: false, output: `Serper search error: ${(err as Error).message}` }
  }
}
