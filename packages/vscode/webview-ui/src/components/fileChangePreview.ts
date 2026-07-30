import type { ToolPart } from "../stores/chat.js"
import type { ApprovalActionView } from "../types/approval.js"

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

const MAX_APPROVAL_DIFF_LINES = 200

/**
 * Parse the authoritative unified diff attached to a write approval. This is
 * the exact proposal produced by the core before the file is mutated, not
 * human-readable tool output. The bounded projection lets the same inline
 * diff component render before and after approval.
 */
function approvalDiffHunks(
  diff: string,
): NonNullable<ToolPart["diffHunks"]> {
  const hunks: NonNullable<ToolPart["diffHunks"]> = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const line of diff.split(/\r?\n/u)) {
    const header = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u.exec(line)
    if (header) {
      oldLine = Number.parseInt(header[1]!, 10)
      newLine = Number.parseInt(header[2]!, 10)
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith("\\ No newline at end of file")) continue
    if (line.startsWith("-") && !line.startsWith("---")) {
      hunks.push({ type: "remove", lineNum: oldLine, line: line.slice(1) })
      oldLine += 1
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      hunks.push({ type: "add", lineNum: newLine, line: line.slice(1) })
      newLine += 1
    } else if (line.startsWith(" ")) {
      oldLine += 1
      newLine += 1
    }
    if (hunks.length >= MAX_APPROVAL_DIFF_LINES) break
  }
  return hunks
}

export function withPendingApprovalPreview(
  part: ToolPart,
  action: ApprovalActionView | null | undefined,
): ToolPart {
  if (!action || action.type !== "write") return part
  const parsed =
    typeof action.diff === "string" && action.diff.trim().length > 0
      ? approvalDiffHunks(action.diff)
      : []
  return {
    ...part,
    path: part.path ?? action.path,
    diffStats: part.diffStats ?? action.diffStats,
    ...(part.diffHunks?.length
      ? { diffHunks: part.diffHunks }
      : parsed.length > 0
        ? { diffHunks: parsed }
        : {}),
  }
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
  const replacements = Array.isArray(part.appliedReplacements)
    ? part.appliedReplacements
    : proposedInputReplacement(part)
  if (replacements.length === 0) return []

  const lines: FileChangePreviewLine[] = []
  for (const replacement of replacements) {
    if (
      !replacement ||
      typeof replacement.oldSnippet !== "string" ||
      typeof replacement.newSnippet !== "string"
    ) {
      continue
    }
    const oldLines = replacement.oldSnippet.split(/\r?\n/u)
    const newLines = replacement.newSnippet.split(/\r?\n/u)
    let prefix = 0
    while (
      prefix < oldLines.length &&
      prefix < newLines.length &&
      oldLines[prefix] === newLines[prefix]
    ) {
      prefix += 1
    }
    let suffix = 0
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] ===
        newLines[newLines.length - 1 - suffix]
    ) {
      suffix += 1
    }
    oldLines.slice(prefix, oldLines.length - suffix).forEach((line, index) => {
      lines.push({
        type: "remove",
        lineNum: prefix + index + 1,
        line,
      })
    })
    newLines.slice(prefix, newLines.length - suffix).forEach((line, index) => {
      lines.push({
        type: "add",
        lineNum: prefix + index + 1,
        line,
      })
    })
  }
  return lines
}

function proposedInputReplacement(
  part: ToolPart,
): Array<{ oldSnippet: string; newSnippet: string }> {
  const input = part.input
  if (!input || typeof input !== "object") return []
  const oldSnippet = input.old_string ?? input.oldString
  const newSnippet = input.new_string ?? input.newString
  if (
    typeof oldSnippet !== "string" ||
    typeof newSnippet !== "string"
  ) {
    return []
  }
  return [{ oldSnippet, newSnippet }]
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
