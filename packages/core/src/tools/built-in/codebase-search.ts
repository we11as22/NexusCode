import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  query: z.string().optional().describe("Semantic search query (natural language description of what you're looking for)"),
  queries: z.array(z.string()).min(1).max(20).optional().describe("Multiple semantic queries in one call"),
  path: z.string().optional().describe("Optional path scope (file or directory, relative to project root)"),
  kind: z.enum(["class", "function", "method", "interface", "type", "enum", "const", "any"]).optional().describe("Filter by symbol type"),
  limit: z.number().int().positive().max(50).optional().describe("Max results (default: 10)"),
  task_progress: z.string().optional(),
})

export const codebaseSearchTool: ToolDef<z.infer<typeof schema>> = {
  name: "codebase_search",
  description: `Search the indexed codebase by semantic meaning or keyword.
Finds relevant classes, functions, methods, types, and code sections.
Searches by symbol name, docstrings, and content.
If vector search is enabled, uses semantic similarity.
Requires the codebase to be indexed (runs automatically on startup).`,
  parameters: schema,
  readOnly: true,

  async execute({ query, queries, path, kind, limit }, ctx: ToolContext) {
    if (!ctx.indexer) {
      return {
        success: false,
        output: "Codebase indexing is not enabled or not ready. Enable it in .nexus/nexus.yaml (indexing.enabled: true).",
      }
    }

    const status = ctx.indexer.status()
    if (status.state === "idle") {
      return { success: false, output: "Codebase index is not yet built. Wait for indexing to complete." }
    }
    if (status.state === "error") {
      return { success: false, output: `Index error: ${(status as any).error}` }
    }

    try {
      const allQueries = (queries?.length ? queries : (query ? [query] : [])).map((q) => q.trim()).filter(Boolean)
      if (allQueries.length === 0) {
        return { success: false, output: "Provide query or queries." }
      }

      const scope = path?.replace(/\\/g, "/").replace(/\/+$/, "")
      const isFileScope = scope != null && /\.[a-z0-9]+$/i.test(scope)
      const sections: string[] = []

      for (const q of allQueries) {
        const raw = await ctx.indexer.search(q, {
          limit: limit ?? 10,
          kind: kind === "any" ? undefined : kind as any,
          semantic: true,
        })

        const filtered = scope
          ? raw.filter((r) => {
              const p = r.path.replace(/\\/g, "/")
              return isFileScope ? p === scope : (p === scope || p.startsWith(`${scope}/`))
            })
          : raw

        if (filtered.length === 0) {
          sections.push(`Query: "${q}"\nNo results.`)
          continue
        }

        const formatted = filtered.map((r, i) => {
          const loc = r.startLine ? `:${r.startLine}` : ""
          const parent = r.parent ? ` (in ${r.parent})` : ""
          const kindStr = r.kind ? `[${r.kind}]` : ""
          return `${i + 1}. ${r.path}${loc} ${kindStr}${parent}\n   ${r.content.slice(0, 200).replace(/\n/g, " ")}`
        }).join("\n\n")
        sections.push(`Query: "${q}"\n${formatted}`)
      }

      return {
        success: true,
        output: `${scope ? `Scope: ${scope}\n\n` : ""}${sections.join("\n\n---\n\n")}`,
      }
    } catch (err) {
      return { success: false, output: `Search failed: ${(err as Error).message}` }
    }
  },
}
