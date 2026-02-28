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
  name: "web_fetch",
  description: `Fetch and read content from a URL.
HTML pages are converted to clean markdown.
JSON/text/code is returned as-is.
Maximum 100KB content.
Useful for: reading documentation, fetching API specs, checking URLs.`,
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
  name: "web_search",
  description: `Search the web using Brave Search or Serper API.
Returns titles, URLs, and snippets for the top results.
Requires BRAVE_API_KEY or SERPER_API_KEY environment variable.
Use web_fetch to read full content of specific results.`,
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
