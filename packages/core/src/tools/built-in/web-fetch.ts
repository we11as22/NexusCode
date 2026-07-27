import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"
import { requestNetworkResource } from "../../network/network-request.js"
import TurndownService from "turndown"
import {
  BROWSER_LIKE_FETCH_UA,
  PRIMARY_FETCH_UA,
  formatSearchHits,
  getFirecrawlApiKey,
  isWebSearchLocalOnly,
  normalizeSearchResultUrl,
  scrapeFirecrawlMarkdown,
  searchDuckDuckGoHtml,
  searchFirecrawl,
  skipFirecrawl,
  type WebSearchHit,
} from "./web-remote.js"

const MAX_CONTENT_BYTES = 100 * 1024 // 100 KB
const FETCH_TIMEOUT = 30_000
const FALLBACK_MAX_BYTES = 5 * 1024 * 1024
const SEARCH_TIMEOUT = 20_000
const SEARCH_MAX_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 5

const schema = z.object({
  url: z.string().max(8192).url().refine((value) => {
    try {
      const protocol = new URL(value).protocol
      return protocol === "http:" || protocol === "https:"
    } catch {
      return false
    }
  }, "URL must use http:// or https://").describe("Public HTTP(S) URL to fetch"),
  max_length: z.number().int().positive().max(200000).optional().describe("Max content length in characters (default: 100000)"),
  task_progress: z.string().optional(),
})

async function fetchTextOnce(
  url: string,
  maxLen: number,
  userAgent: string,
  timeoutMs: number,
  ctx: ToolContext,
): Promise<
  | { ok: true; finalUrl: string; contentType: string; text: string }
  | { ok: false; status?: number; message: string }
> {
  try {
    const response = await requestNetworkResource(ctx.host, url, {
      purpose: "web_fetch",
      signal: ctx.signal,
      timeoutMs,
      maxRedirects: MAX_REDIRECTS,
      maxResponseBytes: FALLBACK_MAX_BYTES,
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
      },
    })
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, message: `HTTP ${response.status} ${response.statusText}` }
    }
    const contentType = response.headers["content-type"] ?? ""
    const dec = new TextDecoder("utf8", { fatal: false })
    let text = dec.decode(response.body)
    if (text.length > maxLen) {
      text = text.slice(0, maxLen) + `\n\n[... content truncated at ${maxLen} chars ...]`
    }
    return { ok: true, finalUrl: response.url, contentType, text }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/aborted|cancelled|timed out|timeout/iu.test(msg)) {
      return { ok: false, message: "Request timed out" }
    }
    return { ok: false, message: msg }
  }
}

async function authorizeFirecrawlTarget(
  url: string,
  ctx: ToolContext,
): Promise<void> {
  if (ctx.signal.aborted) {
    throw ctx.signal.reason ?? new Error("WebFetch was cancelled.")
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener = () => {}
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("WebFetch target authorization timed out.")),
      FETCH_TIMEOUT,
    )
    timeout.unref?.()
  })
  const cancelled = new Promise<never>((_resolve, reject) => {
    const onAbort = () =>
      reject(ctx.signal.reason ?? new Error("WebFetch was cancelled."))
    ctx.signal.addEventListener("abort", onAbort, { once: true })
    removeAbortListener = () =>
      ctx.signal.removeEventListener("abort", onAbort)
  })
  try {
    await Promise.race([
      ctx.host.authorizeNetworkRequest({
        url,
        purpose: "web_fetch",
      }),
      deadline,
      cancelled,
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    removeAbortListener()
  }
}

export const webFetchTool: ToolDef<z.infer<typeof schema>> = {
  name: "WebFetch",
  description: `Fetch public content from an HTTP(S) URL. HTML is converted to markdown; JSON/text returned as-is. This tool requires browser/network permission.

**Backends (OpenClaude-style):** If \`FIRECRAWL_API_KEY\` is set, the tool tries Firecrawl scrape first (better for JS-heavy pages). Otherwise it uses plain HTTP. If that fails, a browser-like User-Agent fallback is tried. Set \`NEXUS_SKIP_FIRECRAWL=1\` to force plain HTTP only even with a Firecrawl key.

When to use:
- Documentation, API specs, or URLs the user provided.
- Extracting text from public pages or checking external references.

When NOT to use:
- Do not guess URLs; use only user-provided or tool-discovered URLs.
- Authenticated or private URLs may fail; use a specialized MCP tool if available.
- Large binaries; this tool is text-oriented.

Every redirect is separately validated against the host network policy. Local, private, link-local, metadata, multicast, and other non-public destinations are blocked.`,
  parameters: schema,
  readOnly: true,

  async execute({ url, max_length }, ctx: ToolContext) {
    const maxLen = max_length ?? MAX_CONTENT_BYTES
    const fcKey = getFirecrawlApiKey()
    if (fcKey && !skipFirecrawl()) {
      try {
        // Firecrawl receives the target URL in its request body rather than
        // connecting through our pinned transport. Authorize that target first.
        await authorizeFirecrawlTarget(url, ctx)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Network target was denied."
        return {
          success: false,
          output: `Blocked WebFetch target ${url}: ${message}`,
        }
      }
      const scraped = await scrapeFirecrawlMarkdown(
        url,
        maxLen,
        fcKey,
        { host: ctx.host, signal: ctx.signal },
      )
      if (scraped) {
        return {
          success: true,
          output: `URL: ${url}\nContent-Type: ${scraped.contentType} (via Firecrawl)\n\n${scraped.text}`,
        }
      }
    }

    let primary = await fetchTextOnce(
      url,
      maxLen,
      PRIMARY_FETCH_UA,
      FETCH_TIMEOUT,
      ctx,
    )
    if (!primary.ok) {
      const fb = await fetchTextOnce(
        url,
        maxLen,
        BROWSER_LIKE_FETCH_UA,
        FETCH_TIMEOUT,
        ctx,
      )
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
  query: z.string().trim().min(1).max(2000).describe("Search query"),
  max_results: z.number().int().positive().max(10).optional().describe("Max results (default: 5)"),
  task_progress: z.string().optional(),
})

export const webSearchTool: ToolDef<z.infer<typeof webSearchSchema>> = {
  name: "WebSearch",
  description: `Search the public web for real-time information. This tool requires browser/network permission.

**Provider order (OpenClaude / ClaudeCodeFree-style):**
1. **Local-only mode** — \`NEXUS_WEB_SEARCH_MODE=local\`: DuckDuckGo HTML only (free; may be rate-limited).
2. Otherwise: **Firecrawl** if \`FIRECRAWL_API_KEY\` is set (set \`NEXUS_SKIP_FIRECRAWL=1\` to skip), then **Brave** (\`BRAVE_API_KEY\`), then **Serper** (\`SERPER_API_KEY\`), then **DuckDuckGo** as free fallback when APIs are missing or return nothing.

Use \`WebFetch\` to read full pages. Include a "Sources:" section with markdown links when you cite results.`,
  parameters: webSearchSchema,
  readOnly: true,

  async execute({ query, max_results }, ctx: ToolContext) {
    const limit = max_results ?? 5

    if (isWebSearchLocalOnly()) {
      const hits = await searchDuckDuckGoHtml(
        query,
        limit,
        { host: ctx.host, signal: ctx.signal },
      )
      return {
        success: true,
        output: formatSearchHits(query, hits, "DuckDuckGo HTML, local-only mode"),
      }
    }

    const fcKey = getFirecrawlApiKey()
    if (fcKey && !skipFirecrawl()) {
      try {
        const hits = await searchFirecrawl(
          query,
          limit,
          fcKey,
          { host: ctx.host, signal: ctx.signal },
        )
        if (hits.length > 0) {
          return { success: true, output: formatSearchHits(query, hits, "Firecrawl") }
        }
      } catch {
        // fall through
      }
    }

    const braveKey = process.env["BRAVE_API_KEY"]?.trim()
    if (braveKey) {
      const r = await searchWithBrave(query, limit, braveKey, ctx)
      if (r.success && r.hits && r.hits.length > 0) {
        return { success: true, output: formatSearchHits(query, r.hits, "Brave Search API") }
      }
      if (!r.success && r.errorText) {
        // Brave misconfigured — still try other backends
      }
    }

    const serperKey = process.env["SERPER_API_KEY"]?.trim()
    if (serperKey) {
      const r = await searchWithSerper(query, limit, serperKey, ctx)
      if (r.success && r.hits && r.hits.length > 0) {
        return { success: true, output: formatSearchHits(query, r.hits, "Serper") }
      }
    }

    const ddg = await searchDuckDuckGoHtml(
      query,
      limit,
      { host: ctx.host, signal: ctx.signal },
    )
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
  ctx: ToolContext,
): Promise<{ success: boolean; hits?: WebSearchHit[]; errorText?: string }> {
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
    const response = await requestNetworkResource(ctx.host, url, {
      purpose: "web_search",
      signal: ctx.signal,
      timeoutMs: SEARCH_TIMEOUT,
      maxRedirects: MAX_REDIRECTS,
      maxResponseBytes: SEARCH_MAX_BYTES,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    })

    if (response.status < 200 || response.status >= 300) {
      return { success: false, errorText: `Brave HTTP ${response.status}` }
    }

    const data = JSON.parse(new TextDecoder("utf8", { fatal: false }).decode(response.body)) as {
      web?: { results?: Array<{ title: string; url: string; description: string }> }
    }
    const results = data.web?.results ?? []
    const hits: WebSearchHit[] = results.flatMap((result) => {
      const url = normalizeSearchResultUrl(result.url)
      return url
        ? [{
            title: result.title,
            url,
            snippet: result.description,
          }]
        : []
    }).slice(0, limit)
    return { success: true, hits }
  } catch (err) {
    return { success: false, errorText: (err as Error).message }
  }
}

async function searchWithSerper(
  query: string,
  limit: number,
  apiKey: string,
  ctx: ToolContext,
): Promise<{ success: boolean; hits?: WebSearchHit[]; errorText?: string }> {
  try {
    const response = await requestNetworkResource(
      ctx.host,
      "https://google.serper.dev/search",
      {
        purpose: "web_search",
        method: "POST",
        signal: ctx.signal,
        timeoutMs: SEARCH_TIMEOUT,
        maxRedirects: MAX_REDIRECTS,
        maxResponseBytes: SEARCH_MAX_BYTES,
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": apiKey,
        },
        body: JSON.stringify({ q: query, num: limit }),
      },
    )

    if (response.status < 200 || response.status >= 300) {
      return { success: false, errorText: `Serper HTTP ${response.status}` }
    }

    const data = JSON.parse(new TextDecoder("utf8", { fatal: false }).decode(response.body)) as {
      organic?: Array<{ title: string; link: string; snippet: string }>
    }
    const results = data.organic ?? []
    const hits: WebSearchHit[] = results.flatMap((result) => {
      const url = normalizeSearchResultUrl(result.link)
      return url
        ? [{
            title: result.title,
            url,
            snippet: result.snippet,
          }]
        : []
    }).slice(0, limit)
    return { success: true, hits }
  } catch (err) {
    return { success: false, errorText: (err as Error).message }
  }
}
