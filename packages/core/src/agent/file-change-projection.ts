import type {
  AppliedReplacement,
  ToolDiffLine,
  ToolPart,
} from "../types.js"
import { normalizedAppliedReplacementsFromMetadata } from "../tools/applied-replacements.js"

const MAX_PERSISTED_DIFF_LINES = 200

export type FileChangeToolProjection = Partial<
  Pick<
    ToolPart,
    "path" | "diffStats" | "diffHunks" | "appliedReplacements"
  >
>

function targetPath(input: Record<string, unknown>): string | undefined {
  const value = input.file_path ?? input.path
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  return normalized || undefined
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? Math.floor(value)
    : undefined
}

function normalizeDiffHunks(value: unknown): ToolDiffLine[] | undefined {
  if (!Array.isArray(value)) return undefined
  const lines: ToolDiffLine[] = []
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      continue
    }
    const line = candidate as Record<string, unknown>
    if (
      (line.type !== "add" && line.type !== "remove") ||
      typeof line.lineNum !== "number" ||
      !Number.isSafeInteger(line.lineNum) ||
      line.lineNum < 0 ||
      typeof line.line !== "string"
    ) {
      continue
    }
    lines.push({
      type: line.type,
      lineNum: line.lineNum,
      line: line.line,
    })
    if (lines.length >= MAX_PERSISTED_DIFF_LINES) break
  }
  return lines.length > 0 ? lines : undefined
}

/**
 * Build the bounded file-change fields shared by the durable ToolPart and the
 * live tool_end event. Full file contents deliberately never enter this
 * projection.
 */
export function projectFileChangeToolResult(
  toolName: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
): FileChangeToolProjection {
  if (toolName !== "Write" && toolName !== "Edit") return {}
  const path = targetPath(input)
  if (!path || !metadata) return {}

  const added = nonnegativeInteger(metadata.addedLines)
  const removed = nonnegativeInteger(metadata.removedLines)
  const diffHunks = normalizeDiffHunks(metadata.diffHunks)
  const appliedReplacements: AppliedReplacement[] | undefined =
    toolName === "Edit"
      ? normalizedAppliedReplacementsFromMetadata(metadata)
      : undefined

  return {
    path,
    ...(added !== undefined && removed !== undefined
      ? { diffStats: { added, removed } }
      : {}),
    ...(diffHunks ? { diffHunks } : {}),
    ...(appliedReplacements ? { appliedReplacements } : {}),
  }
}
