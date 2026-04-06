import { z } from "zod"
import * as path from "node:path"
import * as diff from "diff"
import type { ToolDef, ToolContext } from "../../types.js"
import { buildDiffHunks } from "./diff-hunks.js"
import { isNexusPlansPath } from "../plan-paths.js"

const MAX_DIFF_PREVIEW_LINES = 80

/** CLI: show the model’s replace intent, not a recomputed whole-file line diff. */
const MAX_APPLIED_SNIPPET_CHARS = 900

function truncateForUiSnippet(s: string, max = MAX_APPLIED_SNIPPET_CHARS): string {
  const t = s.replace(/\r\n/g, "\n")
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

/** Normalize to LF for comparison; avoids Edit failing when the model uses \\n but the file is CRLF. */
function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

/** Convert internal \\n segments to the file's native line endings (Kilo/OpenCode-style). */
function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

/**
 * Map model-supplied strings to the file's line endings so literal search/replace matches on disk.
 */
function prepareEditStrings(
  fileContent: string,
  oldString: string,
  newString: string,
): { oldPrepared: string; newPrepared: string } {
  const ending = detectLineEnding(fileContent)
  return {
    oldPrepared: convertToLineEnding(normalizeLineEndings(oldString), ending),
    newPrepared: convertToLineEnding(normalizeLineEndings(newString), ending),
  }
}

function createDiffPreview(oldContent: string, newContent: string, label: string): string {
  const patch = diff.createTwoFilesPatch(label, label, oldContent, newContent, "", "", { context: 2 })
  const lines = patch.split(/\r?\n/)
  if (lines.length <= MAX_DIFF_PREVIEW_LINES) return patch
  return lines.slice(0, MAX_DIFF_PREVIEW_LINES).join("\n") + "\n... (truncated)"
}

const schema = z.object({
  file_path: z.string().min(1).describe("The absolute path to the file to modify"),
  old_string: z.string().min(1).optional().describe("The text to replace"),
  new_string: z.string().optional().describe("The text to replace it with (must be different from old_string)"),
  replace_all: z.boolean().optional().describe("Replace all occurrences of old_string (default false)"),
  blocks: z.array(z.object({
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  })).optional().describe("Optional batched replacements for one Edit call. Applied in order, each block uses the current file content after previous blocks."),
}).superRefine((value, ctx) => {
  const hasSingle = typeof value.old_string === "string" && typeof value.new_string === "string"
  const hasBlocks = Array.isArray(value.blocks) && value.blocks.length > 0
  if (!hasSingle && !hasBlocks) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Provide either old_string/new_string or non-empty blocks.",
      path: ["old_string"],
    })
  }
})

export const editTool: ToolDef<z.infer<typeof schema>> = {
  name: "Edit",
  searchHint: "replace text in file, targeted patch, exact string replacement, modify existing file safely",
  description: `Performs exact string replacements in files.

Usage:
- You MUST use Read at least once in the conversation before editing. This tool will error if you attempt an edit without having read the file.
- When editing text that came from Read output: preserve the exact indentation (tabs/spaces) as it appears in the file. The Read tool returns lines in the format \`LINE_NUMBER|CONTENT\` — the \`LINE_NUMBER|\` prefix is metadata only. Match only the actual file content (everything after that prefix) in old_string and new_string. Never include the line number prefix in old_string or new_string.
- ALWAYS prefer editing existing files. NEVER create new files unless explicitly required.
- Only use emojis if the user explicitly requests them.
- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique, or use replace_all to change every occurrence.
- Prefer one well-scoped replacement over a chain of micro-edits. Re-read first if the file may have drifted after earlier edits.
- Use replace_all for replacing and renaming strings across the entire file (e.g. renaming a variable).
- For multiple changes in the same file, prefer ONE Edit call with \`blocks\` (applied in order) instead of many sequential Edit calls.
- If you need multiple changes in the same file, do not make many tiny Edit calls. Re-read once and apply remaining changes with one larger old_string/new_string replacement when feasible.

When NOT to use:
- Do not use Edit to create a brand-new file; use Write.
- Do not use Edit when the whole file is being replaced; use Write with the final content.
- Do not use Edit with guessed text. If whitespace, quoting, or line endings are uncertain, re-read the exact range first.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ file_path, old_string, new_string, replace_all, blocks }, ctx: ToolContext) {
    const filePath = file_path
    let originalContent: string
    try {
      originalContent = await ctx.host.readFile(filePath)
    } catch {
      return { success: false, output: `File not found: ${filePath}` }
    }

    const editBlocks =
      Array.isArray(blocks) && blocks.length > 0
        ? blocks
        : [{ old_string: old_string ?? "", new_string: new_string ?? "", replace_all }]

    let content = originalContent
    for (let i = 0; i < editBlocks.length; i++) {
      const block = editBlocks[i]!
      const { oldPrepared, newPrepared } = prepareEditStrings(
        content,
        block.old_string,
        block.new_string,
      )
      if (oldPrepared === newPrepared) {
        return {
          success: false,
          output: `Edit block #${i + 1}: old_string and new_string are identical after normalizing line endings; nothing to change in ${filePath}.`,
        }
      }

      if (block.replace_all) {
        const next = content.split(oldPrepared).join(newPrepared)
        if (next === content) {
          return { success: false, output: `Edit block #${i + 1}: no occurrences of old_string found in ${filePath}.` }
        }
        content = next
      } else {
        const idx = content.indexOf(oldPrepared)
        if (idx === -1) {
          return {
            success: false,
            output: `Edit block #${i + 1}: old_string not found in ${filePath}.\nHint: Read the file first to verify the exact content (whitespace, quotes, and line endings must match; try Read again if the file changed).`,
          }
        }
        content =
          content.slice(0, idx) +
          newPrepared +
          content.slice(idx + oldPrepared.length)
      }
    }

    const changesForStats = diff.diffLines(originalContent, content)
    let addedLines = 0
    let removedLines = 0
    for (const c of changesForStats) {
      const lineCount = c.value.split(/\r?\n/).length
      if (c.added) addedLines += lineCount
      if (c.removed) removedLines += lineCount
    }
    const diffStats = { added: addedLines, removed: removedLines }

    const useFileEditFlow =
      typeof ctx.host.openFileEdit === "function" &&
      typeof ctx.host.saveFileEdit === "function" &&
      typeof ctx.host.revertFileEdit === "function"
    const modeAutoApprove = new Set(
      (ctx.mode ? ctx.config.modes?.[ctx.mode]?.autoApprove : undefined) ?? []
    )
    const skipApproval =
      ctx.config.permissions.autoApproveWrite ||
      modeAutoApprove.has("write") ||
      isNexusPlansPath(filePath)

    if (useFileEditFlow) {
      const diffPreview = createDiffPreview(originalContent, content, filePath)
      await ctx.host.openFileEdit!(filePath, {
        originalContent,
        newContent: content,
        isNewFile: false,
      })
      if (!skipApproval) {
        ctx.host.emit({
          type: "tool_approval_needed",
          action: {
            type: "write",
            tool: "Edit",
            description: `Edit ${filePath}`,
            content,
            diff: diffPreview,
            diffStats,
          },
          partId: ctx.partId ?? "",
        })
        const approval = await ctx.host.showApprovalDialog({
          type: "write",
          tool: "Edit",
          description: `Edit ${filePath}`,
          content,
          diff: diffPreview,
          diffStats,
        })
        if (!approval.approved) {
          await ctx.host.revertFileEdit!(filePath)
          return { success: false, output: `User denied edit to ${filePath}` }
        }
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

    const diffHunks = buildDiffHunks(originalContent, content)
    const appliedReplacements = editBlocks.map((b) => ({
      oldSnippet: truncateForUiSnippet(b.old_string),
      newSnippet: truncateForUiSnippet(b.new_string),
    }))
    return {
      success: true,
      output: `Successfully updated ${filePath}\n\n<updated_content>\n${content}\n</updated_content>`,
      metadata: {
        addedLines,
        removedLines,
        diffHunks,
        writtenContent: content,
        appliedReplacements,
      },
    }
  },
}
