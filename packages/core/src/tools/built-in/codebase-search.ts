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
- Run multiple searches in parallel with different phrasings; first-pass results often miss key details.
- Start with \`target_directories: []\` (whole repo) if unsure; then rerun scoped to a directory when results point there.
- Break multi-part questions into focused sub-queries and run them in parallel.

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
