/** SkillNet (OpenKG) public search API — no authentication. */

export const SKILLNET_SEARCH_BASE = "http://api-skillnet.openkg.cn/v1/search"

export interface SkillNetSearchRow {
  skill_name: string
  skill_description: string
  author: string
  stars: number
  skill_url: string
  category: string
}

export interface SkillNetSearchMeta {
  query: string
  mode: string
  total: number
  limit: number
  page: number
}

export interface SkillNetSearchResponse {
  data: SkillNetSearchRow[]
  meta: SkillNetSearchMeta
  success: boolean
}

export interface SkillNetSearchParams {
  q: string
  mode?: "keyword" | "vector"
  category?: string
  limit?: number
  page?: number
  minStars?: number
  sortBy?: "stars" | "recent"
  /** vector mode only, default 0.8 */
  threshold?: number
}

export function buildSkillNetSearchUrl(params: SkillNetSearchParams): string {
  const u = new URL(SKILLNET_SEARCH_BASE)
  u.searchParams.set("q", params.q.trim() || "skill")
  const mode = params.mode ?? "keyword"
  u.searchParams.set("mode", mode)
  if (params.category?.trim()) u.searchParams.set("category", params.category.trim())
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50)
  u.searchParams.set("limit", String(limit))
  if (mode === "keyword") {
    const page = Math.max(params.page ?? 1, 1)
    u.searchParams.set("page", String(page))
    if (params.minStars != null && params.minStars > 0) u.searchParams.set("min_stars", String(params.minStars))
    u.searchParams.set("sort_by", params.sortBy ?? "stars")
  } else {
    u.searchParams.set("threshold", String(params.threshold ?? 0.8))
  }
  return u.toString()
}
