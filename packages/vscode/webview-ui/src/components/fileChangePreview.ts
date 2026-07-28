import type { ToolPart } from "../stores/chat.js"

export type FileChangePreviewLine = {
  type: "add" | "remove"
  lineNum: number
  line: string
}

export type FileChangePreview = {
  lines: FileChangePreviewLine[]
  hiddenLineCount: number
  statusOnly: boolean
  stats: { added: number; removed: number }
}

function exactHunks(part: ToolPart): FileChangePreviewLine[] {
  if (!Array.isArray(part.diffHunks)) return []
  return part.diffHunks.flatMap((candidate) => {
    if (
      (candidate.type !== "add" && candidate.type !== "remove") ||
      !Number.isSafeInteger(candidate.lineNum) ||
      candidate.lineNum < 0 ||
      typeof candidate.line !== "string"
    ) {
      return []
    }
    return [{
      type: candidate.type,
      lineNum: candidate.lineNum,
      line: candidate.line,
    }]
  })
}

function replacementHunks(part: ToolPart): FileChangePreviewLine[] {
  if (
    part.tool !== "Edit" &&
    part.tool !== "replace_in_file"
  ) {
    return []
  }
  if (!Array.isArray(part.appliedReplacements)) return []

  const lines: FileChangePreviewLine[] = []
  for (const replacement of part.appliedReplacements) {
    if (
      !replacement ||
      typeof replacement.oldSnippet !== "string" ||
      typeof replacement.newSnippet !== "string"
    ) {
      continue
    }
    replacement.oldSnippet.split(/\r?\n/u).forEach((line, index) => {
      lines.push({
        type: "remove",
        lineNum: index + 1,
        line,
      })
    })
    replacement.newSnippet.split(/\r?\n/u).forEach((line, index) => {
      lines.push({
        type: "add",
        lineNum: index + 1,
        line,
      })
    })
  }
  return lines
}

function normalizedStats(
  part: ToolPart,
  lines: readonly FileChangePreviewLine[],
): { added: number; removed: number } {
  const stats = part.diffStats
  if (
    stats &&
    Number.isFinite(stats.added) &&
    stats.added >= 0 &&
    Number.isFinite(stats.removed) &&
    stats.removed >= 0
  ) {
    return {
      added: Math.floor(stats.added),
      removed: Math.floor(stats.removed),
    }
  }
  return {
    added: lines.filter((line) => line.type === "add").length,
    removed: lines.filter((line) => line.type === "remove").length,
  }
}

/**
 * Produce a compact, semantic preview from proven structured data only.
 * Human-readable tool output is intentionally ignored: an updated full file
 * is not evidence that every line was added.
 */
export function buildFileChangePreview(
  part: ToolPart,
  maxLines = 6,
): FileChangePreview {
  const exact = exactHunks(part)
  const changedLines = exact.length > 0 ? exact : replacementHunks(part)
  const limit =
    Number.isSafeInteger(maxLines) && maxLines > 0
      ? maxLines
      : 6
  const lines = changedLines.slice(0, limit)
  const stats = normalizedStats(part, changedLines)
  const totalChanged = Math.max(
    changedLines.length,
    stats.added + stats.removed,
  )

  return {
    lines,
    hiddenLineCount: Math.max(0, totalChanged - lines.length),
    statusOnly: lines.length === 0,
    stats,
  }
}

