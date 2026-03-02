import { z } from "zod"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { applyPatch as applyUnifiedPatch } from "diff"
import type { ToolDef, ToolContext } from "../../types.js"

const schema = z.object({
  patch: z.string().describe("Unified diff patch to apply"),
  path: z.string().optional().describe("Override the file path from the patch header"),
  task_progress: z.string().optional(),
})

export const applyPatchTool: ToolDef<z.infer<typeof schema>> = {
  name: "apply_patch",
  description: `Apply a unified diff patch (e.g. from a model or git diff). Patch must be standard unified format (--- a/file +++ b/file).

When to use:
- Model outputs a patch naturally; you have a ready-made diff.
- Applying an external patch file.

When NOT to use:
- Targeted edits: prefer replace_in_file (more reliable, no patch parsing).
- Multiple unrelated edits: use replace_in_file with multiple blocks.
If the patch fails to apply (content mismatch), use replace_in_file instead.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ patch, path: overridePath }, ctx: ToolContext) {
    // Extract file path from patch header if not overridden
    let filePath = overridePath
    if (!filePath) {
      const match = patch.match(/^(?:---|\+\+\+)\s+(?:a\/|b\/)?(.+?)(?:\t.*)?$/m)
      if (match?.[1] && match[1] !== "/dev/null") {
        filePath = match[1]
      }
    }

    if (!filePath) {
      return { success: false, output: "Could not determine target file path from patch" }
    }

    const absPath = path.resolve(ctx.cwd, filePath)

    let originalContent = ""
    try {
      originalContent = await fs.readFile(absPath, "utf8")
    } catch {
      // New file — empty content
    }

    const patched = applyUnifiedPatch(originalContent, patch)
    if (patched === false) {
      return {
        success: false,
        output: `Failed to apply patch to ${filePath}. The patch may not match the current file content. Try replace_in_file instead.`,
      }
    }

    const dirPath = path.dirname(absPath)
    await fs.mkdir(dirPath, { recursive: true })

    const tmpPath = `${absPath}.nexus_tmp_${Date.now()}`
    try {
      await fs.writeFile(tmpPath, patched, "utf8")
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
      output: `Successfully applied patch to ${filePath}`,
    }
  },
}
