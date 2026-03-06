import { z } from "zod"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  query: z.string().describe("A complete question about what you want to understand. Ask as if talking to a colleague: 'How does X work?', 'What happens when Y?', 'Where is Z handled?'"),
  target_directories: z.array(z.string()).optional().describe("Prefix directory paths to limit search scope (single directory only, no glob patterns). Omit or empty to search the whole repo."),
  explanation: z.string().optional().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal."),
  kind: z.enum(["class", "function", "method", "interface", "type", "enum", "const", "any"]).optional().describe("Filter by symbol type"),
  limit: z.number().int().positive().max(50).optional().describe("Max results (default: 10)"),
})

export const codebaseSearchTool: ToolDef<z.infer<typeof schema>> = {
  name: "CodebaseSearch",
  description: `Semantic (vector) search over the indexed codebase. Finds code by meaning, not exact text.

Use CodebaseSearch when you need to:
- Explore unfamiliar codebases
- Ask "how / where / what" questions to understand behavior
- Find code by meaning rather than exact text

When NOT to use:
- Exact text or regex: use Grep instead.
- Reading a known file: use Read.
- Single identifier or symbol overview: use Grep or ListCodeDefinitions.

Query: A complete question with context (e.g. "Where is user authentication validated before login?"). Avoid single words; use full questions.
target_directories: Optional list of directory paths to limit scope. Omit or empty to search whole repo. Start broad then narrow based on results.
Only available when vector search is enabled (indexing.vector + vectorDb.enabled in .nexus/nexus.yaml) and the index is built.`,
  parameters: schema,
  readOnly: true,

  async execute({ query, target_directories, kind, limit }, ctx: ToolContext) {
    const vectorEnabled = Boolean(ctx.config.indexing?.vector && ctx.config.vectorDb?.enabled)
    if (!vectorEnabled) {
      return {
        success: false,
        output: "Vector codebase search is disabled. Enable indexing.vector and vectorDb.enabled in .nexus/nexus.yaml to use codebase_search.",
      }
    }
    if (!ctx.indexer) {
      return {
        success: false,
        output: "Indexer is not ready. Configure embeddings (model + API key) and ensure Qdrant is running, then wait for indexing to complete.",
      }
    }

    const status = ctx.indexer.status()
    if (status.state === "idle") {
      return { success: false, output: "Vector index is not yet built. Wait for indexing to complete or enable vectorDb + embeddings in config." }
    }
    if (status.state === "error") {
      return { success: false, output: `Index error: ${(status as any).error}` }
    }

    try {
      const allQueries = query?.trim() ? [query.trim()] : []
      if (allQueries.length === 0) {
        return { success: false, output: "Provide query." }
      }

      const scopeCandidates = Array.isArray(target_directories) ? target_directories : []
      const normalizedScopes = Array.from(new Set(
        scopeCandidates
          .map((p) => normalizeScopePath(p, ctx.cwd))
          .filter(Boolean)
      ))
      const scopesToUse = normalizedScopes.length > 0 ? normalizedScopes : [""]
      const effectiveLimit = limit ?? 10
      const effectiveKind = kind === "any" ? undefined : (kind as any)

      // Run all (query, scope) searches in parallel
      const pairs: Array<{ q: string; scope: string }> = []
      for (const q of allQueries) {
        for (const s of scopesToUse) {
          pairs.push({ q, scope: s })
        }
      }
      const allRaw = await Promise.all(
        pairs.map(({ q, scope }) =>
          ctx.indexer!.search(q, {
            limit: effectiveLimit,
            kind: effectiveKind,
            semantic: true,
            pathScope: scope || undefined,
          })
        )
      )

      const sections: string[] = []
      let idx = 0
      for (const q of allQueries) {
        const scopedSections: string[] = []
        for (const scope of scopesToUse) {
          const raw = allRaw[idx++] ?? []
          const isFileScope = scope ? /\.[a-z0-9]+$/i.test(scope) : false
          const filtered = scope
            ? raw.filter((r) => {
                const p = r.path.replace(/\\/g, "/")
                return isFileScope ? p === scope : (p === scope || p.startsWith(`${scope}/`))
              })
            : raw

          if (filtered.length === 0) {
            scopedSections.push(`${scope ? `Scope: ${scope}\n` : ""}No results.`)
            continue
          }

          const formatted = filtered.map((r, i) => {
            const loc = r.startLine != null
              ? (r.endLine != null && r.endLine !== r.startLine ? `:${r.startLine}-${r.endLine}` : `:${r.startLine}`)
              : ""
            const parent = r.parent ? ` (in ${r.parent})` : ""
            const kindStr = r.kind ? `[${r.kind}]` : ""
            return `${i + 1}. ${r.path}${loc} ${kindStr}${parent}\n   ${r.content.slice(0, 200).replace(/\n/g, " ")}`
          }).join("\n\n")
          scopedSections.push(`${scope ? `Scope: ${scope}\n` : ""}${formatted}`)
        }
        sections.push(`Query: "${q}"\n${scopedSections.join("\n\n")}`)
      }

      return {
        success: true,
        output: sections.join("\n\n---\n\n"),
      }
    } catch (err) {
      return { success: false, output: `Search failed: ${(err as Error).message}` }
    }
  },
}

function normalizeScopePath(input: string, cwd: string): string {
  const raw = input.trim()
  if (!raw) return ""
  const abs = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
  const rel = path.relative(cwd, abs)
  const safe = rel && !rel.startsWith("..") ? rel : raw
  return safe.replace(/\\/g, "/").replace(/\/+$/, "")
}
