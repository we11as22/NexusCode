import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"
import TurndownService from "turndown"
import {
  BROWSER_LIKE_FETCH_UA,
  PRIMARY_FETCH_UA,
  formatSearchHits,
  getFirecrawlApiKey,
  isWebSearchLocalOnly,
  scrapeFirecrawlMarkdown,
  searchDuckDuckGoHtml,
  searchFirecrawl,
  skipFirecrawl,
  type WebSearchHit,
} from "./web-remote.js"

const MAX_CONTENT_BYTES = 100 * 1024 // 100 KB
const FETCH_TIMEOUT = 30_000
const FALLBACK_MAX_BYTES = 5 * 1024 * 1024

const schema = z.object({
  url: z.string().url().describe("URL to fetch"),
  max_length: z.number().int().positive().max(200000).optional().describe("Max content length in characters (default: 100000)"),
  task_progress: z.string().optional(),
})

async function fetchTextOnce(
  url: string,
  maxLen: number,
  userAgent: string,
  timeoutMs: number,
): Promise<
  | { ok: true; finalUrl: string; contentType: string; text: string }
  | { ok: false; status?: number; message: string }
> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      signal: controller.signal as AbortSignal,
      redirect: "follow",
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      },
    })
    if (!response.ok) {
      return { ok: false, status: response.status, message: `HTTP ${response.status} ${response.statusText}` }
    }
    const contentType = response.headers.get("content-type") ?? ""
    const buf = await response.arrayBuffer()
    if (buf.byteLength > FALLBACK_MAX_BYTES && userAgent === BROWSER_LIKE_FETCH_UA) {
      return { ok: false, message: `Response too large (${buf.byteLength} bytes)` }
    }
    const dec = new TextDecoder("utf8", { fatal: false })
    let text = dec.decode(buf)
    if (text.length > maxLen) {
      text = text.slice(0, maxLen) + `\n\n[... content truncated at ${maxLen} chars ...]`
    }
    return { ok: true, finalUrl: response.url, contentType, text }
  } catch (err: unknown) {
    const msg = (err as Error).message
    if (msg.includes("aborted") || msg.includes("timeout")) {
      return { ok: false, message: "Request timed out" }
    }
    return { ok: false, message: msg }
  } finally {
    clearTimeout(timeoutId)
  }
}

export const webFetchTool: ToolDef<z.infer<typeof schema>> = {
  name: "WebFetch",
  description: `Fetch content from a URL. HTML is converted to markdown; JSON/text returned as-is. Read-only.

**Backends (OpenClaude-style):** If \`FIRECRAWL_API_KEY\` is set, the tool tries Firecrawl scrape first (better for JS-heavy pages). Otherwise it uses plain HTTP. If that fails, a browser-like User-Agent fallback is tried. Set \`NEXUS_SKIP_FIRECRAWL=1\` to force plain HTTP only even with a Firecrawl key.

When to use:
- Documentation, API specs, or URLs the user provided.
- Extracting text from public pages or checking external references.

When NOT to use:
- Do not guess URLs; use only user-provided or tool-discovered URLs.
- Authenticated or private URLs may fail; use a specialized MCP tool if available.
- Large binaries; this tool is text-oriented.

When the response is a redirect to a **different host**, make a new WebFetch with the redirect URL from the message.`,
  parameters: schema,
  readOnly: true,

  async execute({ url, max_length }, _ctx: ToolContext) {
    const maxLen = max_length ?? MAX_CONTENT_BYTES
    const fcKey = getFirecrawlApiKey()
    if (fcKey && !skipFirecrawl()) {
      const scraped = await scrapeFirecrawlMarkdown(url, maxLen, fcKey)
      if (scraped) {
        return {
          success: true,
          output: `URL: ${url}\nContent-Type: ${scraped.contentType} (via Firecrawl)\n\n${scraped.text}`,
        }
      }
    }

    let primary = await fetchTextOnce(url, maxLen, PRIMARY_FETCH_UA, FETCH_TIMEOUT)
    if (!primary.ok) {
      const fb = await fetchTextOnce(url, maxLen, BROWSER_LIKE_FETCH_UA, FETCH_TIMEOUT)
      if (!fb.ok) {
        return {
          success: false,
          output: `Failed to fetch ${url}: ${primary.message}${primary.status != null ? ` (primary HTTP ${primary.status})` : ""}. Fallback: ${fb.message}`,
        }
      }
      primary = fb
    }

    const { finalUrl, contentType, text } = primary
    let body = text
    if (contentType.includes("text/html")) {
      body = htmlToMarkdown(body)
      if (body.length > maxLen) {
        body = body.slice(0, maxLen) + `\n\n[... truncated ...]`
      }
    }

    const hostMismatch =
      (() => {
        try {
          return new URL(finalUrl).hostname !== new URL(url).hostname
        } catch {
          return false
        }
      })()

    const prefix =
      hostMismatch
        ? `URL: ${url}\nFetched after redirect: ${finalUrl}\nContent-Type: ${contentType}\n\n`
        : `URL: ${finalUrl}\nContent-Type: ${contentType}\n\n`

    return {
      success: true,
      output: `${prefix}${body}`,
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
  description: `Search the web for real-time information. Read-only.

**Provider order (OpenClaude / ClaudeCodeFree-style):**
1. **Local-only mode** — \`NEXUS_WEB_SEARCH_MODE=local\`: DuckDuckGo HTML only (free; may be rate-limited).
2. Otherwise: **Firecrawl** if \`FIRECRAWL_API_KEY\` is set (set \`NEXUS_SKIP_FIRECRAWL=1\` to skip), then **Brave** (\`BRAVE_API_KEY\`), then **Serper** (\`SERPER_API_KEY\`), then **DuckDuckGo** as free fallback when APIs are missing or return nothing.

Use \`WebFetch\` to read full pages. Include a "Sources:" section with markdown links when you cite results.`,
  parameters: webSearchSchema,
  readOnly: true,

  async execute({ query, max_results }, _ctx: ToolContext) {
    const limit = max_results ?? 5

    if (isWebSearchLocalOnly()) {
      const hits = await searchDuckDuckGoHtml(query, limit)
      return {
        success: true,
        output: formatSearchHits(query, hits, "DuckDuckGo HTML, local-only mode"),
      }
    }

    const fcKey = getFirecrawlApiKey()
    if (fcKey && !skipFirecrawl()) {
      try {
        const hits = await searchFirecrawl(query, limit, fcKey)
        if (hits.length > 0) {
          return { success: true, output: formatSearchHits(query, hits, "Firecrawl") }
        }
      } catch {
        // fall through
      }
    }

    const braveKey = process.env["BRAVE_API_KEY"]?.trim()
    if (braveKey) {
      const r = await searchWithBrave(query, limit, braveKey)
      if (r.success && r.hits && r.hits.length > 0) {
        return { success: true, output: formatSearchHits(query, r.hits, "Brave Search API") }
      }
      if (!r.success && r.errorText) {
        // Brave misconfigured — still try other backends
      }
    }

    const serperKey = process.env["SERPER_API_KEY"]?.trim()
    if (serperKey) {
      const r = await searchWithSerper(query, limit, serperKey)
      if (r.success && r.hits && r.hits.length > 0) {
        return { success: true, output: formatSearchHits(query, r.hits, "Serper") }
      }
    }

    const ddg = await searchDuckDuckGoHtml(query, limit)
    if (ddg.length > 0) {
      return {
        success: true,
        output: formatSearchHits(query, ddg, "DuckDuckGo HTML (free fallback)"),
      }
    }

    return {
      success: true,
      output: `No results for "${query}". Optional APIs: FIRECRAWL_API_KEY, BRAVE_API_KEY, or SERPER_API_KEY. Free DuckDuckGo path returned no parseable hits (site may have changed or rate-limited).`,
    }
  },
}

async function searchWithBrave(
  query: string,
  limit: number,
  apiKey: string,
): Promise<{ success: boolean; hits?: WebSearchHit[]; errorText?: string }> {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    })

    if (!response.ok) {
      return { success: false, errorText: `Brave HTTP ${response.status}` }
    }

    const data = (await response.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> }
    }
    const results = data.web?.results ?? []
    const hits: WebSearchHit[] = results.slice(0, limit).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
    }))
    return { success: true, hits }
  } catch (err) {
    return { success: false, errorText: (err as Error).message }
  }
}

async function searchWithSerper(
  query: string,
  limit: number,
  apiKey: string,
): Promise<{ success: boolean; hits?: WebSearchHit[]; errorText?: string }> {
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
      return { success: false, errorText: `Serper HTTP ${response.status}` }
    }

    const data = (await response.json()) as { organic?: Array<{ title: string; link: string; snippet: string }> }
    const results = data.organic ?? []
    const hits: WebSearchHit[] = results.slice(0, limit).map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    }))
    return { success: true, hits }
  } catch (err) {
    return { success: false, errorText: (err as Error).message }
  }
}
