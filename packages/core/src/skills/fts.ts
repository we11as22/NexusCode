import type { SkillDef } from "../types.js"

const TOP_SKILLS_FTS = 20
const BM25_K1 = 1.2
const BM25_B = 0.75

/**
 * Tokenize text for full-text matching: lowercase, split on non-alphanumeric, drop short tokens.
 */
function tokenize(text: string): string[] {
  if (!text || typeof text !== "string") return []
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

/**
 * BM25 score for a single term in a document.
 * idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLen / avgDocLen))
 */
function bm25Term(
  tf: number,
  docLen: number,
  avgDocLen: number,
  idf: number
): number {
  if (tf <= 0 || avgDocLen <= 0) return 0
  const norm = 1 - BM25_B + BM25_B * (docLen / avgDocLen)
  return (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * norm)
}

/**
 * Return top N skills by BM25 relevance to task description.
 * Each skill is one "document" (name + summary). Query = task description.
 */
export function ftsTopSkills(
  skills: SkillDef[],
  taskDescription: string,
  topN: number = TOP_SKILLS_FTS
): SkillDef[] {
  if (skills.length === 0) return []
  if (skills.length <= topN) return skills

  const queryTokens = tokenize(taskDescription)
  if (queryTokens.length === 0) {
    return skills.slice(0, topN)
  }

  // Build documents: one per skill (name + summary), with term frequencies and length
  type Doc = {
    skill: SkillDef
    tf: Map<string, number>
    length: number
  }
  const docs: Doc[] = skills.map((skill) => {
    const text = `${skill.name} ${skill.summary}`.trim()
    const tokens = tokenize(text)
    const tf = new Map<string, number>()
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1)
    }
    return { skill, tf, length: tokens.length }
  })

  const N = docs.length
  const totalLen = docs.reduce((s, d) => s + d.length, 0)
  const avgDocLen = totalLen / N || 1

  // Document frequency: number of docs containing each term (from query vocabulary)
  const df = new Map<string, number>()
  for (const term of queryTokens) {
    if (df.has(term)) continue
    let count = 0
    for (const doc of docs) {
      if (doc.tf.has(term)) count++
    }
    df.set(term, count)
  }

  // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
  const idf = new Map<string, number>()
  for (const [term, n] of df) {
    idf.set(term, Math.log((N - n + 0.5) / (n + 0.5) + 1))
  }

  // BM25 score per document
  const scored = docs.map((doc) => {
    let score = 0
    const seen = new Set<string>()
    for (const term of queryTokens) {
      if (seen.has(term)) continue
      seen.add(term)
      const tf = doc.tf.get(term) ?? 0
      score += bm25Term(tf, doc.length, avgDocLen, idf.get(term) ?? 0)
    }
    return { skill: doc.skill, score }
  })

  scored.sort((a, b) => b.score - a.score)

  const result: SkillDef[] = []
  for (let i = 0; i < scored.length && result.length < topN; i++) {
    result.push(scored[i]!.skill)
  }
  return result
}
