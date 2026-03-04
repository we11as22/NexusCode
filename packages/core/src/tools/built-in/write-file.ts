import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  path: z.string().min(1).describe("Path to the file to create or overwrite"),
  content: z.string().describe("The complete content to write to the file"),
})

export const writeFileTool: ToolDef<z.infer<typeof schema>> = {
  name: "write_to_file",
  description: `Create a new file or overwrite an existing file entirely. Use only when replace_in_file is not suitable.

When to use:
- New files, boilerplate, or full rewrites.
- When the change affects more than half of the file.

When NOT to use:
- Small or targeted edits: use replace_in_file (faster, less error-prone).
- Appending or patching: use replace_in_file with search/replace.

WARNING: Replaces entire file content. Provide complete final content. Creates parent directories if needed.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ path: filePath, content }, ctx: ToolContext) {
    const absPath = path.resolve(ctx.cwd, filePath)
    const dirPath = path.dirname(absPath)

    // Create directories if needed
    await fs.mkdir(dirPath, { recursive: true })

    // Atomic write: write to temp file, then rename
    const tmpPath = `${absPath}.nexus_tmp_${Date.now()}`
    try {
      await fs.writeFile(tmpPath, content, "utf8")
      await fs.rename(tmpPath, absPath)
    } catch (err) {
      try { await fs.unlink(tmpPath) } catch {}
      return { success: false, output: `Failed to write ${filePath}: ${(err as Error).message}` }
    }

    const lines = content.split("\n").length
    const indexer = ctx.indexer as { refreshFileNow?: (filePath: string) => Promise<void> } | undefined
    if (indexer?.refreshFileNow) {
      await indexer.refreshFileNow(absPath).catch(() => {})
    } else if (ctx.indexer?.refreshFile) {
      await ctx.indexer.refreshFile(absPath).catch(() => {})
    }
    return {
      success: true,
      output: `Successfully wrote ${filePath} (${lines} lines)`,
    }
  },
}
