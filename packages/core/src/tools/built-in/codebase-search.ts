import { z } from "zod"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  query: z.string().describe("A complete question about what you want to understand. Ask as if talking to a colleague: 'How does X work?', 'What happens when Y?', 'Where is Z handled?' Unless there is a clear reason not to, reuse the user's exact query or phrasing — their wording often helps semantic match."),
  target_directories: z.array(z.string()).optional().describe("Prefix directory paths to limit search scope (single directory only, no glob patterns). Omit or empty to search the whole repo."),
  explanation: z.string().optional().describe("One sentence explanation as to why this tool is being used and how it contributes to the goal."),
  kind: z.enum(["class", "function", "method", "interface", "type", "enum", "const", "any"]).optional().describe("Filter by symbol type"),
  limit: z.coerce.number().int().positive().max(50).optional().describe("Max results (default: 10)"),
})

export const codebaseSearchTool: ToolDef<z.infer<typeof schema>> = {
  name: "CodebaseSearch",
  description: `Semantic (vector) search over the indexed codebase. Finds code by meaning, not exact text.

### When to Use

Use CodebaseSearch when you need to:
- Explore unfamiliar codebases and understand how things work
- Ask "how / where / what" questions about behavior or intent
- Find code by meaning rather than exact text (e.g. "where is the payment processed?")
- Narrow down to a directory once you have initial results

<example>
Query: "Where is interface MyInterface implemented in the frontend?"
Good: complete question asking about implementation location with specific context.
</example>

<example>
Query: "Where do we encrypt user passwords before saving?"
Good: clear question about a specific process with context about when it happens.
</example>

### When NOT to Use

- **Exact text / regex / symbol** → use Grep instead (faster and more precise for known strings).
- **Reading a known file** → use Read (with offset/limit guided by Grep or ListCodeDefinitions results).
- **Single identifier or symbol name** → use Grep or ListCodeDefinitions for exact matching.
- **Finding a file by name** → use Glob.

<example>
Query: "AuthService"
Bad: single-word searches should use Grep for exact text matching instead.
</example>

<example>
Query: "What is AuthService? How does AuthService work?"
Bad: combines two separate queries — split into parallel searches like "What is AuthService?" and "How does AuthService work?"
</example>

### Query Strategy

- Write a complete question as if asking a colleague: "How does X work?", "What happens when Y?", "Where is Z handled?"
- Unless there is a clear reason not to, reuse the user's exact query or phrasing — their wording often helps semantic search.
- Run multiple searches in parallel with different phrasings; first-pass results often miss key details.
- Start with \`target_directories: []\` (whole repo) if unsure; then rerun scoped to a directory when results point there.
- Break multi-part questions into focused sub-queries and run them in parallel (e.g. "Where is X?" and "How does Y work?" in two parallel calls).
- When results show only signatures or snippets for some items, use Read with the path and offset/limit (or Grep) to get full code for those ranges; do not re-read chunks whose full content was already returned.

### Target Directories

- Provide ONE directory or file path; \`[]\` searches the whole repo. No globs or wildcards.
  - Good: \`["backend/api/"]\` — scope to a directory
  - Good: \`["src/components/Button.tsx"]\` — scope to a file
  - Good: \`[]\` — search everywhere when unsure
  - Bad: \`["frontend/", "backend/"]\` — multiple paths (use one per call, run in parallel)
  - Bad: \`["src/**/utils/**"]\` — no globs

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
        output:
          "Indexer is not available in this run (host did not attach an indexer, or server/agent startup timed out waiting for Qdrant). " +
          "In VS Code local mode: wait for indexing after opening the project. In **server** mode: ensure Qdrant and embeddings are reachable from the **server** process. " +
          "Configure embeddings (model + API key), vectorDb, then retry.",
      }
    }

    const semanticOk = ctx.indexer.semanticSearchActive?.() ?? true
    if (!semanticOk) {
      return {
        success: false,
        output:
          "Semantic search is off at runtime even though indexing.vector and vectorDb.enabled are true in YAML. " +
          "The indexer started without Qdrant/embeddings (check host logs for [nexus]: Qdrant unavailable, missing embeddings API key, or embeddings init failed). " +
          "Fix Qdrant URL/reachability, set embeddings.apiKey (or OPENAI_API_KEY / OPENROUTER_API_KEY), press Sync to re-index.",
      }
    }

    const status = ctx.indexer.status()
    if (status.state === "idle") {
      return { success: false, output: "Vector index is not yet built. Wait for indexing to complete or enable vectorDb + embeddings in config." }
    }
    if (status.state === "stopping") {
      return {
        success: false,
        output: "Indexer is stopping (abort in progress). Wait until the status is idle or ready, then retry CodebaseSearch.",
      }
    }
    /** Default on: allow partial vector search whenever Qdrant already has points. Set `false` in YAML to block until indexing completes. */
    const searchWhileIndexing = ctx.config.indexing?.searchWhileIndexing !== false
    if (status.state === "indexing" && !searchWhileIndexing) {
      const pct =
        typeof (status as { overallPercent?: number }).overallPercent === "number"
          ? (status as { overallPercent: number }).overallPercent
          : undefined
      return {
        success: false,
        output:
          pct != null
            ? `Index is still building (~${pct}% on the current step — files or chunks). Retry when finished, or enable “CodebaseSearch while indexing” in Settings → Index (default: on) / set indexing.searchWhileIndexing: true in nexus.yaml.`
            : "Index is still building. Retry CodebaseSearch after indexing finishes, or enable search-while-indexing in Settings → Index.",
      }
    }
    if (status.state === "error") {
      return { success: false, output: `Index error: ${(status as { error?: string }).error ?? "unknown"}` }
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
      const snippetMax = Math.max(1, ctx.config.indexing?.codebaseSearchSnippetMaxChars ?? 4000)

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
            const scoreStr = r.score != null ? ` score=${r.score.toFixed(4)}` : ""
            const snippet = r.content.slice(0, snippetMax).replace(/\n/g, "\n   ")
            return `${i + 1}. ${r.path}${loc}${scoreStr} ${kindStr}${parent}\n   ${snippet}`
          }).join("\n\n")
          scopedSections.push(`${scope ? `Scope: ${scope}\n` : ""}${formatted}`)
        }
        sections.push(`Query: "${q}"\n${scopedSections.join("\n\n")}`)
      }

      const partialNote =
        status.state === "indexing" && searchWhileIndexing
          ? "Results may be incomplete while the index is still building.\n\n"
          : ""
      return {
        success: true,
        output: partialNote + sections.join("\n\n---\n\n"),
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
