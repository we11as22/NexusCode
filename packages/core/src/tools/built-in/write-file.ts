import { z } from "zod"
import * as path from "node:path"
import * as diff from "diff"
import type { ToolDef, ToolContext } from "../../types.js"
import { buildDiffHunks } from "./diff-hunks.js"
import { isNexusPlansPath } from "../plan-paths.js"
import type { CapturedFileState } from "../../changes/types.js"
import {
  applyDurableTextFileChange,
  buildDurableChangeHunks,
  capturedText,
  exactLineDiffStats,
} from "../file-change-flow.js"

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
  searchHint: "create file, overwrite whole file, new file scaffold, full file rewrite",
  description: `Create a new file or overwrite an existing file entirely.

When to use:
- New files, boilerplate, or full rewrites.
- When the change affects more than half of the file.
- When you already know the exact final contents and a targeted Edit would be more complex or fragile than rewriting the whole file.
- When you need to replace a generated or machine-written file wholesale and preserving tiny local hunks is not important.

When NOT to use:
- Small or targeted edits: use Edit (faster, less error-prone).
- Appending or patching: use Edit with search/replace.
- **Existing files:** If the file already exists, you MUST use Read first to read its contents. This tool will fail if you attempt to write to an existing file without having read it first. Then use either Edit for targeted changes or Write with the complete final content.
- NEVER proactively create documentation files (*.md, README). Only create them if the user explicitly requests.
- Only use emojis in file content if the user explicitly asks.
- Do not use Write when you have not yet decided the final file contents. Explore first, then write once.

WARNING: Write replaces the entire file. Provide complete final content, not a patch or fragment. Creates parent directories if needed.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ file_path: filePath, content }, ctx: ToolContext) {
    const absPath = path.resolve(ctx.cwd, filePath)
    if (
      !ctx.changeSetService ||
      !ctx.executionIdentity ||
      typeof ctx.host.readFileState !== "function" ||
      typeof ctx.host.applyFileMutation !== "function"
    ) {
      return {
        success: false,
        output:
          `Failed to write ${filePath}: durable ChangeSet support is required`,
      }
    }

    let captured: CapturedFileState
    let oldContent: string | null
    try {
      captured = await ctx.host.readFileState(filePath)
      oldContent = capturedText(captured)
    } catch (error) {
      return {
        success: false,
        output:
          `Failed to read ${filePath}: ` +
          (error instanceof Error ? error.message : String(error)),
      }
    }

    const originalContentStr = oldContent ?? ""

    const newLines = content.split(/\r?\n/).length
    // Full-file line diff for approval/review. Unlike split/set-based
    // projections this preserves duplicate lines and trailing-newline
    // semantics.
    const {
      added: addedLines,
      removed: removedLines,
    } = exactLineDiffStats(originalContentStr, content)
    const diffStats = { added: addedLines, removed: removedLines }

    const modeAutoApprove = new Set(
      (ctx.mode ? ctx.config.modes?.[ctx.mode]?.autoApprove : undefined) ?? []
    )
    const skipApprovalByConfig =
      ctx.config.permissions.autoApproveWrite ||
      modeAutoApprove.has("write") ||
      isNexusPlansPath(filePath)
    const approvalRequired =
      ctx.fileEditApproval?.required ?? !skipApprovalByConfig

    const diffPreview = createDiffPreview(
      originalContentStr,
      content,
      filePath,
    )
    const diffHunks = buildDiffHunks(originalContentStr, content)
    const durableHunks = buildDurableChangeHunks(
      originalContentStr,
      content,
    )
    const durable = await applyDurableTextFileChange(ctx, {
      toolName: "Write",
      filePath,
      original: captured,
      content,
      diff: diffPreview,
      diffStats,
      approvalRequired,
      permissionRule: ctx.fileEditApproval?.permissionRule ?? false,
      hunks: durableHunks,
    })
    if (!durable?.success) {
      return durable ?? {
        success: false,
        output: `Failed to write ${filePath}: durable change service is unavailable`,
      }
    }

    const indexer = ctx.indexer as { refreshFileNow?: (filePath: string) => Promise<void> } | undefined
    if (indexer?.refreshFileNow) {
      await indexer.refreshFileNow(absPath).catch(() => {})
    } else if (ctx.indexer?.refreshFile) {
      await ctx.indexer.refreshFile(absPath).catch(() => {})
    }

    return {
      success: true,
      output: `Successfully wrote ${filePath} (${newLines} lines)`,
      metadata: {
        addedLines,
        removedLines,
        diffHunks,
        writtenContent: content,
        ...durable.metadata,
      },
    }
  },
}
