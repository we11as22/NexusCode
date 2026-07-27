import type { MemoryRecord } from "../types.js"

export interface RetrievedMemory {
  memory: MemoryRecord
  score: number
  reasons: string[]
  citation: string
  estimatedChars: number
}

export interface MemoryRetrievalResult {
  items: RetrievedMemory[]
  totalChars: number
  excluded: {
    expired: number
    superseded: number
    contradicted: number
    duplicate: number
    irrelevant: number
    budget: number
  }
}

export interface MemoryRetrievalOptions {
  memories: MemoryRecord[]
  query: string
  limit?: number
  maxChars?: number
  now?: number
  /** Optional healthy vector-service similarity scores keyed by memory id (0..1). */
  vectorScores?: ReadonlyMap<string, number> | Record<string, number>
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "while", "have",
  "will", "your", "about", "there", "their", "what", "when", "where", "which",
  "were", "been", "does", "did", "then", "than", "they", "you", "are", "was",
  "who", "why", "how", "can", "could", "should", "would", "want", "need", "use",
  "used", "как", "что", "это", "для", "или", "при", "над", "под", "его", "её",
  "она", "они", "мы", "вы", "все", "так", "уже", "ещё", "если", "где", "когда",
  "почему", "который", "которая", "которые", "нужно", "надо", "можно", "быть",
])

const RU_SUFFIXES = [
  "ирования", "ирование", "ированию", "ированный", "ированная", "ированные",
  "изация", "изации", "изацию", "ация", "ации", "ацию", "ением", "ение",
  "ениями", "ового", "овой", "овые", "овый", "ыми", "ами", "ями", "ого",
  "ему", "ому", "иях", "иях", "ах", "ях", "ов", "ев", "ий", "ый", "ая",
  "ое", "ые", "ой", "ам", "ям", "ом", "ем", "ую", "юю", "а", "я", "ы", "и",
]
const EN_SUFFIXES = ["ization", "ations", "ation", "ments", "ment", "ingly", "ing", "edly", "ed", "ies", "es", "s"]

function stem(token: string): string {
  const suffixes = /[а-яё]/u.test(token) ? RU_SUFFIXES : EN_SUFFIXES
  for (const suffix of suffixes) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, -suffix.length)
    }
  }
  return token
}

export function tokenizeMemoryText(text: string): string[] {
  return [...new Set(
    (text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_./:-]+/gu) ?? [])
      .filter((token) => token.length >= 2 && !STOPWORDS.has(token))
      .map(stem)
      .filter((token) => token.length >= 2),
  )]
}

function trustRank(trust: MemoryRecord["trust"]): number {
  switch (trust) {
    case "user": return 5
    case "trusted": return 4
    case "agent": return 3
    case "external": return 2
    default: return 1
  }
}

function stronger(left: MemoryRecord, right: MemoryRecord): MemoryRecord {
  const trust = trustRank(left.trust) - trustRank(right.trust)
  if (trust !== 0) return trust > 0 ? left : right
  if (left.updatedAt !== right.updatedAt) return left.updatedAt > right.updatedAt ? left : right
  return left.id.localeCompare(right.id) <= 0 ? left : right
}

function score(memory: MemoryRecord, queryTokens: string[], now: number): { score: number; reasons: string[] } {
  const titleTokens = new Set(tokenizeMemoryText(memory.title))
  const contentTokens = new Set(tokenizeMemoryText(memory.content))
  const metadataTokens = new Set(tokenizeMemoryText(JSON.stringify(memory.metadata ?? {})))
  let value = 0
  let matches = 0
  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      value += 10
      matches += 1
    } else if (contentTokens.has(token)) {
      value += 4
      matches += 1
    } else if (metadataTokens.has(token)) {
      value += 2
      matches += 1
    }
  }
  const reasons: string[] = []
  if (matches > 0) reasons.push("query-match")
  if (memory.scope === "session" && matches > 0) {
    value += 2
    reasons.push("session-scope")
  }
  if (memory.trust === "user" && matches > 0) {
    value += 2
    reasons.push("user-authored")
  } else if (memory.trust === "trusted" && matches > 0) {
    value += 1
    reasons.push("trusted-source")
  }
  const ageHours = Math.max(0, (now - memory.updatedAt) / 3_600_000)
  if (matches > 0 && ageHours < 24) {
    value += ageHours < 1 ? 2 : 1
    reasons.push("recent")
  }
  if (memory.metadata?.pinned === true) {
    value += 20
    reasons.push("pinned")
  }
  value *= Math.max(0.1, memory.confidence)
  return { score: value, reasons }
}

function vectorScore(
  scores: MemoryRetrievalOptions["vectorScores"],
  memoryId: string,
): number | undefined {
  const value = scores && typeof (scores as ReadonlyMap<string, number>).get === "function"
    ? (scores as ReadonlyMap<string, number>).get(memoryId)
    : (scores as Record<string, number> | undefined)?.[memoryId]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined
}

export function retrieveMemories(options: MemoryRetrievalOptions): MemoryRetrievalResult {
  const now = options.now ?? Date.now()
  const maxChars = Math.max(0, options.maxChars ?? 8_000)
  const limit = Math.max(0, options.limit ?? 8)
  const excluded = {
    expired: 0,
    superseded: 0,
    contradicted: 0,
    duplicate: 0,
    irrelevant: 0,
    budget: 0,
  }
  const active = options.memories.filter((memory) => {
    if (typeof memory.expiresAt === "number" && memory.expiresAt <= now) {
      excluded.expired += 1
      return false
    }
    return true
  })
  const activeById = new Map(active.map((memory) => [memory.id, memory]))
  const superseded = new Set<string>()
  for (const memory of active) {
    for (const targetId of memory.supersedes ?? []) {
      const target = activeById.get(targetId)
      if (
        target &&
        target.id !== memory.id &&
        stronger(memory, target).id === memory.id
      ) {
        superseded.add(target.id)
      }
    }
  }
  let candidates = active.filter((memory) => {
    if (superseded.has(memory.id)) {
      excluded.superseded += 1
      return false
    }
    return true
  })
  const byId = new Map(candidates.map((memory) => [memory.id, memory]))
  const contradicted = new Set<string>()
  for (const memory of candidates) {
    for (const otherId of memory.contradicts ?? []) {
      const other = byId.get(otherId)
      if (!other) continue
      contradicted.add(stronger(memory, other).id === memory.id ? other.id : memory.id)
    }
  }
  candidates = candidates.filter((memory) => {
    if (contradicted.has(memory.id)) {
      excluded.contradicted += 1
      return false
    }
    return true
  })

  const queryTokens = tokenizeMemoryText(options.query)
  const ranked = candidates
    .map((memory) => {
      const lexical = score(memory, queryTokens, now)
      const semantic = vectorScore(options.vectorScores, memory.id)
      return {
        memory,
        score: lexical.score + (semantic !== undefined ? semantic * 8 : 0),
        reasons: semantic !== undefined && semantic > 0
          ? [...lexical.reasons, "vector-match"]
          : lexical.reasons,
      }
    })
    .filter((item) => {
      if (item.score <= 0) {
        excluded.irrelevant += 1
        return false
      }
      return true
    })
    .sort((a, b) =>
      b.score - a.score ||
      trustRank(b.memory.trust) - trustRank(a.memory.trust) ||
      b.memory.updatedAt - a.memory.updatedAt ||
      a.memory.id.localeCompare(b.memory.id),
    )

  const seen = new Set<string>()
  const items: RetrievedMemory[] = []
  let totalChars = 0
  for (const item of ranked) {
    if (items.length >= limit) break
    const dedupeKey = `${item.memory.scope}:${item.memory.title.trim().toLowerCase()}:${item.memory.content.trim().toLowerCase()}`
    if (seen.has(dedupeKey)) {
      excluded.duplicate += 1
      continue
    }
    seen.add(dedupeKey)
    const estimatedChars = item.memory.title.length + item.memory.content.length + 240
    if (totalChars + estimatedChars > maxChars) {
      excluded.budget += 1
      continue
    }
    totalChars += estimatedChars
    items.push({
      ...item,
      citation: `memory:${item.memory.id}`,
      estimatedChars,
    })
  }
  return { items, totalChars, excluded }
}
