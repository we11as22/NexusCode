import { parse as parseYaml } from "yaml"
import type {
  MarketplaceItem,
  McpMarketplaceItem,
  SkillMarketplaceItem,
  SkillSearchMeta,
  SkillInstallHint,
} from "./types.js"
import { kebabToTitleCase } from "./strings.js"
import {
  buildSkillNetSearchUrl,
  type SkillNetSearchRow,
  type SkillNetSearchResponse,
} from "./skillnet.js"

/** Hosted marketplace API (MCP list); skills use SkillNet separately. */
const KILO_MARKETPLACE_BASE = "https://api.kilo.ai/api/marketplace"

/** How long cached MCP / SkillNet responses are reused (same query + params). */
const CACHE_TTL_MS = 300_000
const MAX_RETRIES = 3
const TIMEOUT = 25_000

interface CacheEntry {
  data: unknown
  timestamp: number
}

function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return parseYaml(text) as unknown
  }
}

function sanitizeSkillId(raw: string): string {
  const s = raw
    .trim()
    .replace(/[^a-zA-Z0-9\-_@.]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return (s || "skill").slice(0, 128)
}

/** Stable cache key for SkillNet params (field order independent). */
function skillSearchCacheKey(opts: SkillSearchOptions): string {
  const normalized = {
    q: (opts.q ?? "").trim() || "skill",
    mode: opts.mode ?? "keyword",
    category: (opts.category ?? "").trim(),
    limit: Math.min(Math.max(opts.limit ?? 24, 1), 50),
    page: Math.max(opts.page ?? 1, 1),
    threshold: opts.threshold,
  }
  return `skillnet:${JSON.stringify(normalized)}`
}

/** SkillNet sometimes returns the same skill row multiple times; one card per URL. */
function dedupeSkillNetRows(rows: SkillNetSearchRow[]): SkillNetSearchRow[] {
  const seen = new Set<string>()
  const out: SkillNetSearchRow[] = []
  for (const row of rows) {
    const u = (row.skill_url ?? "").trim()
    if (!u || seen.has(u)) continue
    seen.add(u)
    out.push(row)
  }
  return out
}

function transformSkillNetRow(row: SkillNetSearchRow): SkillMarketplaceItem {
  const id = sanitizeSkillId(row.skill_name)
  const display = kebabToTitleCase(row.skill_name.replace(/_/g, "-"))
  const cat = row.category?.trim() || "General"
  const hint: SkillInstallHint = { kind: "github_blob", url: row.skill_url.trim() }
  return {
    type: "skill",
    id,
    name: row.skill_name,
    displayName: display,
    description: row.skill_description ?? "",
    author: row.author,
    category: cat,
    displayCategory: cat,
    githubUrl: row.skill_url,
    content: "",
    skillInstall: hint,
    stars: typeof row.stars === "number" ? row.stars : undefined,
  }
}

async function fetchWithRetry(url: string, attempt = 0): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)

  try {
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    return await response.text()
  } catch (err) {
    clearTimeout(timer)
    if (attempt >= MAX_RETRIES - 1) throw err
    const delay = 1000 * Math.pow(2, attempt)
    await new Promise((resolve) => setTimeout(resolve, delay))
    return fetchWithRetry(url, attempt + 1)
  }
}

export interface SkillSearchOptions {
  q: string
  mode?: "keyword" | "vector"
  category?: string
  limit?: number
  page?: number
  threshold?: number
}

export class MarketplaceApiClient {
  private cache = new Map<string, CacheEntry>()
  /** Coalesce identical in-flight requests (cache miss) so rapid UI changes don't stack duplicate network calls. */
  private inFlight = new Map<string, Promise<unknown>>()

  private getCached(key: string): unknown | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.cache.delete(key)
      return undefined
    }
    return entry.data
  }

  private setCache(key: string, data: unknown): void {
    this.cache.set(key, { data, timestamp: Date.now() })
  }

  /** MCP catalog from Kilo marketplace API (`/mcps`). Skills are loaded via SkillNet elsewhere. */
  private async fetchMcps(bypassCache = false): Promise<McpMarketplaceItem[]> {
    const cacheKey = "mcps"
    if (!bypassCache) {
      const cached = this.getCached(cacheKey) as McpMarketplaceItem[] | undefined
      if (cached) return cached
      const inflight = this.inFlight.get(cacheKey) as Promise<McpMarketplaceItem[]> | undefined
      if (inflight) return inflight
    }

    const promise = (async (): Promise<McpMarketplaceItem[]> => {
      const text = await fetchWithRetry(`${KILO_MARKETPLACE_BASE}/mcps`)
      const parsed = parseResponse(text) as { items?: unknown[] }
      const items = (parsed.items ?? []) as Array<Record<string, unknown>>
      const result = items.map((item) => ({ ...item, type: "mcp" as const }) as McpMarketplaceItem)
      if (!bypassCache) this.setCache(cacheKey, result)
      return result
    })().finally(() => {
      if (!bypassCache) this.inFlight.delete(cacheKey)
    })

    if (!bypassCache) this.inFlight.set(cacheKey, promise as Promise<unknown>)
    return promise
  }

  private async fetchSkillsFromSkillNet(opts: SkillSearchOptions, bypassCache = false): Promise<{
    skills: SkillMarketplaceItem[]
    meta: SkillSearchMeta
  }> {
    const cacheKey = skillSearchCacheKey(opts)
    if (!bypassCache) {
      const cached = this.getCached(cacheKey) as { skills: SkillMarketplaceItem[]; meta: SkillSearchMeta } | undefined
      if (cached) return cached
      const inflight = this.inFlight.get(cacheKey) as Promise<{
        skills: SkillMarketplaceItem[]
        meta: SkillSearchMeta
      }> | undefined
      if (inflight) return inflight
    }

    const promise = (async (): Promise<{ skills: SkillMarketplaceItem[]; meta: SkillSearchMeta }> => {
      const url = buildSkillNetSearchUrl({
        q: opts.q,
        mode: opts.mode ?? "keyword",
        category: opts.category,
        limit: opts.limit ?? 24,
        page: opts.page ?? 1,
        threshold: opts.threshold,
      })
      const text = await fetchWithRetry(url)
      const parsed = parseResponse(text) as Partial<SkillNetSearchResponse>
      if (!Array.isArray(parsed.data)) {
        throw new Error("SkillNet: unexpected response (missing data array)")
      }
      const rows = dedupeSkillNetRows(parsed.data)
      const skills = rows.map(transformSkillNetRow)
      const m = parsed.meta
      const meta: SkillSearchMeta = {
        query: m?.query ?? opts.q,
        mode: m?.mode ?? (opts.mode ?? "keyword"),
        total: typeof m?.total === "number" ? m.total : skills.length,
        limit: typeof m?.limit === "number" ? m.limit : (opts.limit ?? 24),
        page: typeof m?.page === "number" ? m.page : (opts.page ?? 1),
      }
      const payload = { skills, meta }
      if (!bypassCache) this.setCache(cacheKey, payload)
      return payload
    })().finally(() => {
      if (!bypassCache) this.inFlight.delete(cacheKey)
    })

    if (!bypassCache) this.inFlight.set(cacheKey, promise as Promise<unknown>)
    return promise
  }

  async fetchAll(options?: {
    includeSkills?: boolean
    skillSearch?: SkillSearchOptions
    bypassCache?: boolean
  }): Promise<{
    items: MarketplaceItem[]
    errors: string[]
    skillSearchMeta?: SkillSearchMeta
  }> {
    const errors: string[] = []
    const includeSkills = options?.includeSkills !== false
    const bypassCache = options?.bypassCache === true

    const mcps = await this.fetchMcps(bypassCache).catch((err: unknown) => {
      errors.push(`MCP catalog: ${err instanceof Error ? err.message : String(err)}`)
      return [] as McpMarketplaceItem[]
    })

    let skills: SkillMarketplaceItem[] = []
    let skillSearchMeta: SkillSearchMeta | undefined

    if (includeSkills) {
      const search = options?.skillSearch ?? { q: "skill", mode: "keyword" as const, limit: 24, page: 1 }
      try {
        const r = await this.fetchSkillsFromSkillNet(search, bypassCache)
        skills = r.skills
        skillSearchMeta = r.meta
      } catch (err: unknown) {
        errors.push(`SkillNet: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return {
      items: [...mcps, ...skills],
      errors,
      skillSearchMeta,
    }
  }

  clearCache(): void {
    this.cache.clear()
  }

  dispose(): void {
    this.cache.clear()
    this.inFlight.clear()
  }
}
