/**
 * OpenClaude-style web backends: optional Firecrawl, DuckDuckGo HTML fallback
 * (aligned with ClaudeCodeFree direct backend parsing).
 */

import type { IHost } from "../../types.js"
import { requestNetworkResource } from "../../network/network-request.js"

const SEARCH_TIMEOUT_MS = 20_000
const FIRECRAWL_TIMEOUT_MS = 45_000
const SEARCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const FIRECRAWL_MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5

const PRIMARY_FETCH_UA = "NexusCode/1.0 (AI coding assistant; +https://github.com/nexuscode)"
/** Opencode-style fallback when plain fetch fails or returns a challenge page. */
export const BROWSER_LIKE_FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export type WebSearchHit = { title: string; url: string; snippet?: string }

export interface WebRemoteContext {
  host: IHost
  signal?: AbortSignal
}

export function firecrawlBaseUrl(): string {
  const raw = process.env["FIRECRAWL_API_URL"]?.trim()
  if (raw) return raw.replace(/\/+$/, "")
  return "https://api.firecrawl.dev/v1"
}

export function getFirecrawlApiKey(): string | undefined {
  const k = process.env["FIRECRAWL_API_KEY"]?.trim()
  return k || undefined
}

export function isWebSearchLocalOnly(): boolean {
  const v = process.env["NEXUS_WEB_SEARCH_MODE"]?.trim().toLowerCase()
  return v === "local"
}

export function skipFirecrawl(): boolean {
  return process.env["NEXUS_SKIP_FIRECRAWL"] === "1" || process.env["NEXUS_SKIP_FIRECRAWL"] === "true"
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
}

function normalizeHref(rawHref: string): string | null {
  const href = decodeHtmlEntities(rawHref.trim())
  try {
    if (href.startsWith("//duckduckgo.com/l/?")) {
      const parsed = new URL(`https:${href}`)
      const uddg = parsed.searchParams.get("uddg")
      return uddg ? normalizeSearchResultUrl(decodeURIComponent(uddg)) : null
    }
    if (href.startsWith("//")) {
      return normalizeSearchResultUrl(`https:${href}`)
    }
    if (href.startsWith("https://duckduckgo.com/l/?") || href.startsWith("http://duckduckgo.com/l/?")) {
      const parsed = new URL(href)
      const uddg = parsed.searchParams.get("uddg")
      return uddg ? normalizeSearchResultUrl(decodeURIComponent(uddg)) : null
    }
    if (href.startsWith("/l/?")) {
      const parsed = new URL(`https://duckduckgo.com${href}`)
      const uddg = parsed.searchParams.get("uddg")
      return uddg ? normalizeSearchResultUrl(decodeURIComponent(uddg)) : null
    }
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return normalizeSearchResultUrl(href)
    }
    return null
  } catch {
    return null
  }
}

function containsCyrillic(text: string): boolean {
  return /[\u0400-\u04FF]/u.test(text)
}

/**
 * Free path: DuckDuckGo HTML (may be rate-limited; same approach as OpenClaude / ClaudeCodeFree).
 */
export async function searchDuckDuckGoHtml(
  query: string,
  limit: number,
  context: WebRemoteContext,
): Promise<WebSearchHit[]> {
  const kl = containsCyrillic(query) ? "ru-ru" : "us-en"
  const params = new URLSearchParams({ q: query.trim(), kl })
  const response = await requestNetworkResource(
    context.host,
    `https://html.duckduckgo.com/html/?${params}`,
    {
      purpose: "web_search",
      signal: context.signal,
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      maxResponseBytes: SEARCH_MAX_RESPONSE_BYTES,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": PRIMARY_FETCH_UA,
      },
    },
  )
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `DuckDuckGo HTTP ${response.status} ${response.statusText}`.trim(),
    )
  }
  const html = new TextDecoder("utf8", { fatal: false }).decode(response.body)

  const results: WebSearchHit[] = []
  const seen = new Set<string>()
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const url = normalizeHref(m[1] ?? "")
    const title = stripTags(m[2] ?? "")
    if (!url || !title || seen.has(url)) continue
    seen.add(url)
    results.push({ title, url })
    if (results.length >= limit) break
  }
  return results
}

export async function searchFirecrawl(
  query: string,
  limit: number,
  apiKey: string,
  context: WebRemoteContext,
): Promise<WebSearchHit[]> {
  const base = firecrawlBaseUrl()
  const response = await requestNetworkResource(
    context.host,
    `${base}/search`,
    {
      purpose: "web_search",
      method: "POST",
      signal: context.signal,
      timeoutMs: FIRECRAWL_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      maxResponseBytes: FIRECRAWL_MAX_RESPONSE_BYTES,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: query.trim(), limit }),
    },
  )
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Firecrawl search HTTP ${response.status}`)
  }
  const json = parseJsonResponse(response.body) as Record<string, unknown>
  const raw =
    Array.isArray(json["data"])
      ? (json["data"] as unknown[])
      : Array.isArray((json["data"] as Record<string, unknown> | undefined)?.["web"])
        ? ((json["data"] as { web: unknown[] }).web)
        : []
  const out: WebSearchHit[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const o = item as Record<string, unknown>
    const rawUrl =
      typeof o["url"] === "string"
        ? o["url"]
        : typeof o["link"] === "string"
          ? o["link"]
          : ""
    const url = normalizeSearchResultUrl(rawUrl)
    if (!url) continue
    const title =
      typeof o["title"] === "string" && o["title"].trim()
        ? o["title"].trim()
        : url
    const snippet =
      typeof o["description"] === "string"
        ? o["description"]
        : typeof o["snippet"] === "string"
          ? o["snippet"]
          : undefined
    out.push({ title, url, snippet })
    if (out.length >= limit) break
  }
  return out
}

export type ScrapeResult = { text: string; contentType: string; via: "firecrawl" | "http" | "http-fallback" }

export async function scrapeFirecrawlMarkdown(
  url: string,
  maxChars: number,
  apiKey: string,
  context: WebRemoteContext,
): Promise<ScrapeResult | null> {
  const base = firecrawlBaseUrl()
  try {
    const response = await requestNetworkResource(
      context.host,
      `${base}/scrape`,
      {
        purpose: "web_fetch",
        method: "POST",
        signal: context.signal,
        timeoutMs: FIRECRAWL_TIMEOUT_MS,
        maxRedirects: MAX_REDIRECTS,
        maxResponseBytes: FIRECRAWL_MAX_RESPONSE_BYTES,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          url,
          formats: ["markdown"],
        }),
      },
    )
    if (response.status < 200 || response.status >= 300) return null
    const json = parseJsonResponse(response.body) as Record<string, unknown>
    if (json["success"] === false) return null
    const data = json["data"] as Record<string, unknown> | undefined
    if (!data || typeof data !== "object") return null
    const md =
      typeof data["markdown"] === "string"
        ? data["markdown"]
        : typeof data["content"] === "string"
          ? data["content"]
          : ""
    if (!md.trim()) return null
    let text = md
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + `\n\n[... truncated at ${maxChars} chars ...]`
    }
    return { text, contentType: "text/markdown", via: "firecrawl" }
  } catch {
    return null
  }
}

function parseJsonResponse(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf8", { fatal: false }).decode(body))
}

export function normalizeSearchResultUrl(raw: string): string | null {
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

export function formatSearchHits(query: string, hits: WebSearchHit[], sourceNote: string): string {
  if (hits.length === 0) {
    return `No results found for: "${query}" (${sourceNote}).`
  }
  const lines = hits.map(
    (r, i) =>
      `${i + 1}. **${r.title}**\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
  )
  return `Search results for "${query}" (${sourceNote}):\n\n${lines.join("\n\n")}`
}

export { PRIMARY_FETCH_UA }
