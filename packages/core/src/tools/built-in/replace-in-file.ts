import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const searchReplaceBlock = z.object({
  search: z.string().describe("Exact text to find in the file (must match exactly)"),
  replace: z.string().describe("Text to replace the search block with"),
})

const schema = z.object({
  path: z.string().describe("Path to the file to modify"),
  diff: z.array(searchReplaceBlock).min(1).describe("One or more search/replace blocks to apply"),
})

export const replaceInFileTool: ToolDef<z.infer<typeof schema>> = {
  name: "replace_in_file",
  description: `Make targeted edits with SEARCH/REPLACE blocks. Preferred over write_to_file for existing files.

When to use:
- Bug fixes, adding/changing functions, updating imports, small edits.
- Multiple related edits in one file (stack several blocks in one call).
- When you know the exact text to change (read the file first if unsure).

When NOT to use:
- New files or >50% of file changing: use write_to_file.
- Unclear exact content: read_file first to get exact text and indentation.

Rules:
- search must match exactly (whitespace and indentation). Blocks applied in order.
- Tool returns full updated content — use it as reference for next edits.
- If search appears multiple times, only the first occurrence is replaced.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ path: filePath, diff }, ctx: ToolContext) {
    const absPath = path.resolve(ctx.cwd, filePath)

    let content: string
    try {
      content = await fs.readFile(absPath, "utf8")
    } catch {
      return { success: false, output: `File not found: ${filePath}` }
    }

    const originalContent = content
    const results: string[] = []

    for (let i = 0; i < diff.length; i++) {
      const block = diff[i]!
      const idx = content.indexOf(block.search)
      if (idx === -1) {
        return {
          success: false,
          output: `Block ${i + 1}: SEARCH text not found in ${filePath}.\nSearch text:\n${block.search.slice(0, 200)}\n\nHint: Read the file first to verify the exact content.`,
        }
      }
      content = content.slice(0, idx) + block.replace + content.slice(idx + block.search.length)
      const line = originalContent.slice(0, idx).split("\n").length
      results.push(`Block ${i + 1}: replaced at line ~${line}`)
    }

    // Atomic write
    const tmpPath = `${absPath}.nexus_tmp_${Date.now()}`
    try {
      await fs.writeFile(tmpPath, content, "utf8")
      await fs.rename(tmpPath, absPath)
    } catch (err) {
      try { await fs.unlink(tmpPath) } catch {}
      return { success: false, output: `Failed to write: ${(err as Error).message}` }
    }

    const indexer = ctx.indexer as { refreshFileNow?: (filePath: string) => Promise<void> } | undefined
    if (indexer?.refreshFileNow) {
      await indexer.refreshFileNow(absPath).catch(() => {})
    } else if (ctx.indexer?.refreshFile) {
      await ctx.indexer.refreshFile(absPath).catch(() => {})
    }

    return {
      success: true,
      output: `Successfully updated ${filePath}:\n${results.join("\n")}\n\n<updated_content>\n${content}\n</updated_content>`,
    }
  },
}
