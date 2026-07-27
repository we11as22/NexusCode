const BM25_K1 = 1.2
const BM25_B = 0.75

export interface Bm25Document<T> {
  value: T
  text: string
}

export interface Bm25Match<T> {
  value: T
  score: number
  index: number
}

/**
 * Unicode-aware tokenization shared by deterministic capability catalogs.
 * Single-character tokens are ignored to keep broad queries from dominating.
 */
export function tokenizeSearchText(text: string): string[] {
  if (!text) return []
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2)
}

/**
 * Deterministic in-memory BM25 search. Stable input order breaks equal-score
 * ties so catalog results do not change across hosts or JavaScript engines.
 */
export function searchBm25<T>(
  documents: Array<Bm25Document<T>>,
  query: string,
  limit: number,
): Array<Bm25Match<T>> {
  if (documents.length === 0 || limit <= 0) return []
  const queryTerms = [...new Set(tokenizeSearchText(query))]
  if (queryTerms.length === 0) return []

  const indexed = documents.map((document, index) => {
    const tokens = tokenizeSearchText(document.text)
    const termFrequency = new Map<string, number>()
    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1)
    }
    return {
      ...document,
      index,
      length: tokens.length,
      termFrequency,
    }
  })
  const averageLength =
    indexed.reduce((total, document) => total + document.length, 0) /
      indexed.length || 1

  const documentFrequency = new Map<string, number>()
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      indexed.reduce(
        (count, document) =>
          count + (document.termFrequency.has(term) ? 1 : 0),
        0,
      ),
    )
  }

  return indexed
    .map((document) => {
      let score = 0
      for (const term of queryTerms) {
        const frequency = document.termFrequency.get(term) ?? 0
        if (frequency === 0) continue
        const matchingDocuments = documentFrequency.get(term) ?? 0
        const inverseDocumentFrequency = Math.log(
          (indexed.length - matchingDocuments + 0.5) /
            (matchingDocuments + 0.5) +
            1,
        )
        const lengthNormalization =
          1 -
          BM25_B +
          BM25_B * (document.length / averageLength)
        score +=
          (inverseDocumentFrequency * frequency * (BM25_K1 + 1)) /
          (frequency + BM25_K1 * lengthNormalization)
      }
      return {
        value: document.value,
        score,
        index: document.index,
      }
    })
    .filter((match) => match.score > 0)
    .sort((left, right) =>
      right.score - left.score || left.index - right.index
    )
    .slice(0, limit)
}
