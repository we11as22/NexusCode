import { z } from "zod"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  query: z.string().optional().describe("Semantic search query (natural language description of what you're looking for)"),
  queries: z.array(z.string()).min(1).max(20).optional().describe("Multiple semantic queries in one call"),
  path: z.string().optional().describe("Optional path scope (file or directory, relative to project root)"),
  paths: z.array(z.string()).min(1).max(20).optional().describe("Multiple path scopes (files and/or directories)"),
  kind: z.enum(["class", "function", "method", "interface", "type", "enum", "const", "any"]).optional().describe("Filter by symbol type"),
  limit: z.number().int().positive().max(50).optional().describe("Max results (default: 10)"),
  task_progress: z.string().optional(),
})

export const codebaseSearchTool: ToolDef<z.infer<typeof schema>> = {
  name: "codebase_search",
  description: `Semantic (vector) search over the indexed codebase. Finds code by meaning, not exact text.
Only available when vector search is enabled (indexing.vector + vectorDb.enabled in .nexus/nexus.yaml) and the index is built (embeddings configured, Qdrant running).

When to use:
- Explore codebase by intent: "where is auth validated", "error handling for API calls", "how does caching work".
- Use the query field for natural-language descriptions of what you want to find.
- path/paths: optional scope (directory or file). Omit to search whole repo.
- kind: filter by symbol type (class, function, interface, etc.).
- limit: max results (default 10). Use read_file with path:line from results to load only relevant sections.

When NOT to use:
- Exact text or regex: use grep instead.
- Reading a known file: use read_file.
- Single identifier: use grep or list_code_definitions.`,
  parameters: schema,
  readOnly: true,

  async execute({ query, queries, path, paths, kind, limit }, ctx: ToolContext) {
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
      const allQueries = (queries?.length ? queries : (query ? [query] : [])).map((q) => q.trim()).filter(Boolean)
      if (allQueries.length === 0) {
        return { success: false, output: "Provide query or queries." }
      }

      const scopeCandidates = [
        ...(path ? [path] : []),
        ...(Array.isArray(paths) ? paths : []),
      ]
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
