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

const searchReplaceBlock = z.object({
  search: z.string().min(1).describe("Exact text to find in the file (must match exactly, cannot be empty)"),
  replace: z.string().describe("Text to replace the search block with"),
})

const schema = z.object({
  path: z.string().min(1).describe("Path to the file to modify"),
  diff: z.array(searchReplaceBlock).min(1).describe("All edits for this file in one call: one or more search/replace blocks (prefer many blocks in one call over multiple tool calls)"),
})

export const replaceInFileTool: ToolDef<z.infer<typeof schema>> = {
  name: "replace_in_file",
  description: `Make targeted edits with SEARCH/REPLACE blocks. Preferred over write_to_file for existing files.

**One call per file:** Call this tool at most once per file per turn. Put ALL edits for that file in a single call by passing multiple blocks in \`diff\`. Multiple separate calls to the same file are slower, waste turns, and can fail (later searches may not find text after earlier edits). Ideal: one replace_in_file call per file with all changes in \`diff\`.

When to use:
- Bug fixes, adding/changing functions, updating imports, small edits.
- Multiple related edits in one file (stack several blocks in one call).
- When you know the exact text to change (read the file first if unsure).

When NOT to use:
- New files or >50% of file changing: use write_to_file.
- Unclear exact content: read_file first to get exact text and indentation.

Rules:
- search must match exactly (whitespace and indentation). Include sufficient context in each block so the match is unique and the edit is unambiguous. Minimize unchanged code in the block; but each block should have enough surrounding context that the replacement is clear. Blocks are applied in order.
- Tool returns full updated content — use it as reference for next edits.
- If search appears multiple times, only the first occurrence is replaced.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ path: filePath, diff: diffBlocks }, ctx: ToolContext) {
    let originalContent: string
    try {
      originalContent = await ctx.host.readFile(filePath)
    } catch {
      return { success: false, output: `File not found: ${filePath}` }
    }

    // Find all match positions in the ORIGINAL content so all blocks apply to the same snapshot.
    // Apply from end to start so indices remain valid.
    type Replacement = { start: number; end: number; replace: string; blockIndex: number; lineNum: number }
    const replacements: Replacement[] = []
    for (let i = 0; i < diffBlocks.length; i++) {
      const block = diffBlocks[i]!
      const idx = originalContent.indexOf(block.search)
      if (idx === -1) {
        return {
          success: false,
          output: `Block ${i + 1}: SEARCH text not found in ${filePath}.\nSearch text:\n${block.search.slice(0, 200)}\n\nHint: Read the file first to verify the exact content.`,
        }
      }
      const lineNum = originalContent.slice(0, idx).split("\n").length
      replacements.push({
        start: idx,
        end: idx + block.search.length,
        replace: block.replace,
        blockIndex: i,
        lineNum,
      })
    }

    replacements.sort((a, b) => b.start - a.start)

    let content = originalContent
    for (const r of replacements) {
      content = content.slice(0, r.start) + r.replace + content.slice(r.end)
    }

    const results = replacements
      .sort((a, b) => a.blockIndex - b.blockIndex)
      .map((r) => `Block ${r.blockIndex + 1}: replaced at line ~${r.lineNum}`)

    // Roo/Cline-style: open → approve → save or revert (when host supports it)
    const useFileEditFlow =
      typeof ctx.host.openFileEdit === "function" &&
      typeof ctx.host.saveFileEdit === "function" &&
      typeof ctx.host.revertFileEdit === "function"

    if (useFileEditFlow) {
      const diffPreview = createDiffPreview(originalContent, content, filePath)
      await ctx.host.openFileEdit!(filePath, {
        originalContent,
        newContent: content,
        isNewFile: false,
      })
      ctx.host.emit({
        type: "tool_approval_needed",
        action: {
          type: "write",
          tool: "replace_in_file",
          description: `Edit ${filePath}`,
          content,
          diff: diffPreview,
        },
        partId: ctx.partId ?? "",
      })
      const approval = await ctx.host.showApprovalDialog({
        type: "write",
        tool: "replace_in_file",
        description: `Edit ${filePath}`,
        content,
        diff: diffPreview,
      })
      if (!approval.approved) {
        await ctx.host.revertFileEdit!(filePath)
        return { success: false, output: `User denied edit to ${filePath}` }
      }
      try {
        await ctx.host.saveFileEdit!(filePath)
      } catch (err) {
        return { success: false, output: `Failed to write: ${(err as Error).message}` }
      }
    } else {
      try {
        await ctx.host.writeFile(filePath, content)
      } catch (err) {
        return { success: false, output: `Failed to write: ${(err as Error).message}` }
      }
    }

    const absPath = path.resolve(ctx.cwd, filePath)
    const indexer = ctx.indexer as { refreshFileNow?: (filePath: string) => Promise<void> } | undefined
    if (indexer?.refreshFileNow) {
      await indexer.refreshFileNow(absPath).catch(() => {})
    } else if (ctx.indexer?.refreshFile) {
      await ctx.indexer.refreshFile(absPath).catch(() => {})
    }

    const changes = diff.diffLines(originalContent, content)
    let addedLines = 0
    let removedLines = 0
    for (const c of changes) {
      const lineCount = c.value.split(/\r?\n/).length
      if (c.added) addedLines += lineCount
      if (c.removed) removedLines += lineCount
    }

    const diffHunks = buildDiffHunks(originalContent, content)
    return {
      success: true,
      output: `Successfully updated ${filePath}:\n${results.join("\n")}\n\n<updated_content>\n${content}\n</updated_content>`,
      metadata: { addedLines, removedLines, diffHunks, writtenContent: content },
    }
  },
}
