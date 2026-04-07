/**
 * OpenClaude-style web backends: optional Firecrawl, DuckDuckGo HTML fallback
 * (aligned with ClaudeCodeFree direct backend parsing).
 */

const SEARCH_TIMEOUT_MS = 20_000
const FIRECRAWL_TIMEOUT_MS = 45_000

const PRIMARY_FETCH_UA = "NexusCode/1.0 (AI coding assistant; +https://github.com/nexuscode)"
/** Opencode-style fallback when plain fetch fails or returns a challenge page. */
export const BROWSER_LIKE_FETCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export type WebSearchHit = { title: string; url: string; snippet?: string }

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
      return uddg ? decodeURIComponent(uddg) : null
    }
    if (href.startsWith("//")) {
      return `https:${href}`
    }
    if (href.startsWith("https://duckduckgo.com/l/?") || href.startsWith("http://duckduckgo.com/l/?")) {
      const parsed = new URL(href)
      const uddg = parsed.searchParams.get("uddg")
      return uddg ? decodeURIComponent(uddg) : null
    }
    if (href.startsWith("/l/?")) {
      const parsed = new URL(`https://duckduckgo.com${href}`)
      const uddg = parsed.searchParams.get("uddg")
      return uddg ? decodeURIComponent(uddg) : null
    }
    if (href.startsWith("http://") || href.startsWith("https://")) {
      return href
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
export async function searchDuckDuckGoHtml(query: string, limit: number): Promise<WebSearchHit[]> {
  const kl = containsCyrillic(query) ? "ru-ru" : "us-en"
  const params = new URLSearchParams({ q: query.trim(), kl })
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
  let html: string
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": PRIMARY_FETCH_UA,
      },
    })
    html = await res.text()
  } finally {
    clearTimeout(t)
  }

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

export async function searchFirecrawl(query: string, limit: number, apiKey: string): Promise<WebSearchHit[]> {
  const base = firecrawlBaseUrl()
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/search`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: query.trim(), limit }),
    })
    if (!res.ok) {
      throw new Error(`Firecrawl search HTTP ${res.status}`)
    }
    const json = (await res.json()) as Record<string, unknown>
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
      const url = typeof o["url"] === "string" ? o["url"] : typeof o["link"] === "string" ? o["link"] : ""
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
      if (!url) continue
      out.push({ title, url, snippet })
      if (out.length >= limit) break
    }
    return out
  } finally {
    clearTimeout(t)
  }
}

export type ScrapeResult = { text: string; contentType: string; via: "firecrawl" | "http" | "http-fallback" }

export async function scrapeFirecrawlMarkdown(url: string, maxChars: number, apiKey: string): Promise<ScrapeResult | null> {
  const base = firecrawlBaseUrl()
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/scrape`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
      }),
    })
    if (!res.ok) return null
    const json = (await res.json()) as Record<string, unknown>
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
  } finally {
    clearTimeout(t)
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
