import { z } from "zod"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  query: z.string().describe("Semantic search query (natural language description of what you're looking for)"),
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

  async execute({ query, kind, limit }, ctx: ToolContext) {
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
      const results = await ctx.indexer.search(query, {
        limit: limit ?? 10,
        kind: kind === "any" ? undefined : kind as any,
        semantic: true,
      })

      if (results.length === 0) {
        return { success: true, output: `No results found for: "${query}"` }
      }

      const formatted = results.map((r, i) => {
        const loc = r.startLine ? `:${r.startLine}` : ""
        const parent = r.parent ? ` (in ${r.parent})` : ""
        const kindStr = r.kind ? `[${r.kind}]` : ""
        return `${i + 1}. ${r.path}${loc} ${kindStr}${parent}\n   ${r.content.slice(0, 200).replace(/\n/g, " ")}`
      }).join("\n\n")

      return {
        success: true,
        output: `Found ${results.length} results for "${query}":\n\n${formatted}`,
      }
    } catch (err) {
      return { success: false, output: `Search failed: ${(err as Error).message}` }
    }
  },
}
