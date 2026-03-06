import { z } from "zod"
import * as path from "node:path"
import * as diff from "diff"
import type { ToolDef, ToolContext } from "../../types.js"
import { buildDiffHunks } from "./diff-hunks.js"

const MAX_DIFF_PREVIEW_LINES = 80

function createDiffPreview(oldContent: string, newContent: string, label: string): string {
  const patch = diff.createTwoFilesPatch(label, label, oldContent, newContent, "", "", { context: 2 })
  const lines = patch.split(/\r?\n/)
  if (lines.length <= MAX_DIFF_PREVIEW_LINES) return patch
  return lines.slice(0, MAX_DIFF_PREVIEW_LINES).join("\n") + "\n... (truncated)"
}

const schema = z.object({
  file_path: z.string().min(1).describe("Path to the file to create or overwrite (absolute or relative to project root)"),
  content: z.string().describe("The complete content to write to the file"),
})

export const writeFileTool: ToolDef<z.infer<typeof schema>> = {
  name: "Write",
  description: `Create a new file or overwrite an existing file entirely. Use only when Edit is not suitable.

When to use:
- New files, boilerplate, or full rewrites.
- When the change affects more than half of the file.

When NOT to use:
- Small or targeted edits: use Edit (faster, less error-prone).
- Appending or patching: use Edit with search/replace.
- **Existing files:** If the file already exists, read it first with Read so you have the exact content; then either use Edit for targeted changes or Write with complete final content. Do not create documentation files (*.md, README) unless the user explicitly requests them.

WARNING: Replaces entire file content. Provide complete final content. Creates parent directories if needed.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ file_path: filePath, content }, ctx: ToolContext) {
    const absPath = path.resolve(ctx.cwd, filePath)

    let oldContent: string | null = null
    try {
      const exists = await ctx.host.exists(filePath)
      if (exists) {
        oldContent = await ctx.host.readFile(filePath)
      }
    } catch {
      // File does not exist — new file
    }

    const originalContentStr = oldContent ?? ""
    const isNewFile = oldContent == null

    const newLines = content.split(/\r?\n/).length
    let addedLines: number
    let removedLines: number
    if (oldContent != null) {
      const changes = diff.diffLines(oldContent, content)
      addedLines = 0
      removedLines = 0
      for (const c of changes) {
        const lineCount = c.value.split(/\r?\n/).length
        if (c.added) addedLines += lineCount
        if (c.removed) removedLines += lineCount
      }
    } else {
      addedLines = newLines
      removedLines = 0
    }
    const diffStats = { added: addedLines, removed: removedLines }

    // Roo/Cline-style: open → approve → save or revert (when host supports it)
    const useFileEditFlow =
      typeof ctx.host.openFileEdit === "function" &&
      typeof ctx.host.saveFileEdit === "function" &&
      typeof ctx.host.revertFileEdit === "function"

    if (useFileEditFlow) {
      const diffPreview = createDiffPreview(originalContentStr, content, filePath)
      await ctx.host.openFileEdit!(filePath, {
        originalContent: originalContentStr,
        newContent: content,
        isNewFile,
      })
      ctx.host.emit({
        type: "tool_approval_needed",
        action: {
          type: "write",
          tool: "Write",
          description: `Write to ${filePath}`,
          content,
          diff: diffPreview,
          diffStats,
        },
        partId: ctx.partId ?? "",
      })
      const approval = await ctx.host.showApprovalDialog({
        type: "write",
        tool: "Write",
        description: `Write to ${filePath}`,
        content,
        diff: diffPreview,
        diffStats,
      })
      if (!approval.approved) {
        await ctx.host.revertFileEdit!(filePath)
        return { success: false, output: `User denied write to ${filePath}` }
      }
      try {
        await ctx.host.saveFileEdit!(filePath)
      } catch (err) {
        return { success: false, output: `Failed to write ${filePath}: ${(err as Error).message}` }
      }
    } else {
      try {
        await ctx.host.writeFile(filePath, content)
      } catch (err) {
        return { success: false, output: `Failed to write ${filePath}: ${(err as Error).message}` }
      }
    }

    const indexer = ctx.indexer as { refreshFileNow?: (filePath: string) => Promise<void> } | undefined
    if (indexer?.refreshFileNow) {
      await indexer.refreshFileNow(absPath).catch(() => {})
    } else if (ctx.indexer?.refreshFile) {
      await ctx.indexer.refreshFile(absPath).catch(() => {})
    }

    const diffHunks = buildDiffHunks(originalContentStr, content)
    return {
      success: true,
      output: `Successfully wrote ${filePath} (${newLines} lines)`,
      metadata: { addedLines, removedLines, diffHunks, writtenContent: content },
    }
  },
}
