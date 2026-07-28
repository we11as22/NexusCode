import { z } from "zod"
import * as diff from "diff"

import type {
  CapturedFileState,
  ChangeProposalFile,
} from "../../changes/types.js"
import type { ToolContext, ToolDef, ToolResult } from "../../types.js"
import {
  applyDurableFileChangeSet,
  buildDurableChangeHunks,
  capturedStatePrecondition,
  capturedText,
  exactLineDiffStats,
} from "../file-change-flow.js"

const BEGIN_PATCH = "*** Begin Patch"
const END_PATCH = "*** End Patch"
const ADD_FILE = "*** Add File: "
const DELETE_FILE = "*** Delete File: "
const UPDATE_FILE = "*** Update File: "
const MOVE_TO = "*** Move to: "
const END_OF_FILE = "*** End of File"
const MAX_DIFF_PREVIEW_LINES = 400
const MAX_DIFF_PREVIEW_CHARS = 64 * 1024

export interface ApplyPatchChunk {
  readonly changeContext?: string
  readonly oldLines: readonly string[]
  readonly newLines: readonly string[]
  readonly endOfFile: boolean
}

export type ApplyPatchOperation =
  | {
      readonly type: "add"
      readonly path: string
      readonly content: string
    }
  | {
      readonly type: "delete"
      readonly path: string
    }
  | {
      readonly type: "update"
      readonly path: string
      readonly movePath?: string
      readonly chunks: readonly ApplyPatchChunk[]
    }

export interface ParsedApplyPatch {
  readonly raw: string
  readonly operations: readonly ApplyPatchOperation[]
}

export class ApplyPatchParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined ? message : `${message} at line ${line}`)
    this.name = "ApplyPatchParseError"
  }
}

function unwrapPatchText(input: string): string {
  const normalized = input.replace(/\r\n?/gu, "\n").trim()
  const lines = normalized.split("\n")
  if (
    lines.length >= 4 &&
    ["<<EOF", "<<'EOF'", '<<"EOF"'].includes(lines[0] ?? "") &&
    lines.at(-1) === "EOF"
  ) {
    return lines.slice(1, -1).join("\n").trim()
  }
  return normalized
}

function requiredPath(
  line: string,
  marker: string,
  lineNumber: number,
): string {
  const value = line.slice(marker.length).trim()
  if (!value) {
    throw new ApplyPatchParseError(
      `Patch header ${marker.trim()} requires a path`,
      lineNumber,
    )
  }
  if (value.includes("\0")) {
    throw new ApplyPatchParseError("Patch path contains NUL", lineNumber)
  }
  return value
}

function isFileHeader(line: string): boolean {
  return (
    line.startsWith(ADD_FILE) ||
    line.startsWith(DELETE_FILE) ||
    line.startsWith(UPDATE_FILE)
  )
}

export function parseApplyPatch(input: string): ParsedApplyPatch {
  const raw = unwrapPatchText(input)
  const lines = raw.split("\n")
  if (lines[0]?.trim() !== BEGIN_PATCH) {
    throw new ApplyPatchParseError(
      `The first line of the patch must be '${BEGIN_PATCH}'`,
      1,
    )
  }
  if (lines.at(-1)?.trim() !== END_PATCH) {
    throw new ApplyPatchParseError(
      `The last line of the patch must be '${END_PATCH}'`,
      lines.length,
    )
  }

  const operations: ApplyPatchOperation[] = []
  let index = 1
  const endIndex = lines.length - 1
  while (index < endIndex) {
    const line = lines[index] ?? ""
    const lineNumber = index + 1
    if (line.startsWith(ADD_FILE)) {
      const filePath = requiredPath(line, ADD_FILE, lineNumber)
      index += 1
      const content: string[] = []
      while (index < endIndex && !isFileHeader(lines[index] ?? "")) {
        const contentLine = lines[index] ?? ""
        if (!contentLine.startsWith("+")) {
          throw new ApplyPatchParseError(
            "Add File requires every content line to start with '+'",
            index + 1,
          )
        }
        content.push(contentLine.slice(1))
        index += 1
      }
      if (content.length === 0) {
        throw new ApplyPatchParseError(
          "Add File requires at least one '+' line",
          lineNumber,
        )
      }
      operations.push({
        type: "add",
        path: filePath,
        content: `${content.join("\n")}\n`,
      })
      continue
    }

    if (line.startsWith(DELETE_FILE)) {
      operations.push({
        type: "delete",
        path: requiredPath(line, DELETE_FILE, lineNumber),
      })
      index += 1
      continue
    }

    if (line.startsWith(UPDATE_FILE)) {
      const filePath = requiredPath(line, UPDATE_FILE, lineNumber)
      index += 1
      let movePath: string | undefined
      if ((lines[index] ?? "").startsWith(MOVE_TO)) {
        movePath = requiredPath(lines[index]!, MOVE_TO, index + 1)
        index += 1
      }
      const chunks: ApplyPatchChunk[] = []
      while (index < endIndex && !isFileHeader(lines[index] ?? "")) {
        const contextLine = lines[index] ?? ""
        if (contextLine !== "@@" && !contextLine.startsWith("@@ ")) {
          throw new ApplyPatchParseError(
            "Update chunk must start with '@@' or '@@ <context>'",
            index + 1,
          )
        }
        const changeContext =
          contextLine === "@@" ? undefined : contextLine.slice(3)
        index += 1
        const oldLines: string[] = []
        const newLines: string[] = []
        let endOfFile = false
        let changed = false
        while (
          index < endIndex &&
          !isFileHeader(lines[index] ?? "") &&
          (lines[index] ?? "") !== "@@" &&
          !(lines[index] ?? "").startsWith("@@ ")
        ) {
          const changeLine = lines[index] ?? ""
          if (changeLine === END_OF_FILE) {
            endOfFile = true
            index += 1
            break
          }
          const prefix = changeLine[0]
          const value = changeLine.slice(1)
          if (prefix === " ") {
            oldLines.push(value)
            newLines.push(value)
          } else if (prefix === "-") {
            oldLines.push(value)
            changed = true
          } else if (prefix === "+") {
            newLines.push(value)
            changed = true
          } else {
            throw new ApplyPatchParseError(
              "Update lines must start with ' ', '+', or '-'",
              index + 1,
            )
          }
          index += 1
        }
        if (!changed) {
          throw new ApplyPatchParseError(
            "Update chunk contains no added or removed lines",
            lineNumber,
          )
        }
        chunks.push({
          ...(changeContext === undefined ? {} : { changeContext }),
          oldLines,
          newLines,
          endOfFile,
        })
      }
      if (chunks.length === 0 && movePath === undefined) {
        throw new ApplyPatchParseError(
          `Empty update for '${filePath}'`,
          lineNumber,
        )
      }
      operations.push({
        type: "update",
        path: filePath,
        ...(movePath ? { movePath } : {}),
        chunks,
      })
      continue
    }

    throw new ApplyPatchParseError(
      "Invalid hunk header",
      lineNumber,
    )
  }
  if (operations.length === 0) {
    throw new ApplyPatchParseError("Patch must contain at least one file operation")
  }
  return { raw, operations }
}

export function extractApplyPatchPaths(input: string): string[] {
  const parsed = parseApplyPatch(input)
  const paths: string[] = []
  for (const operation of parsed.operations) {
    paths.push(operation.path)
    if (operation.type === "update" && operation.movePath) {
      paths.push(operation.movePath)
    }
  }
  return paths
}

function findUniqueSequence(
  lines: readonly string[],
  pattern: readonly string[],
  start: number,
  endOfFile: boolean,
  filePath: string,
): number {
  if (pattern.length === 0) return endOfFile ? lines.length : start
  const last = lines.length - pattern.length
  const matches: number[] = []
  const first = endOfFile ? last : start
  const final = endOfFile ? last : last
  for (let at = Math.max(0, first); at <= final; at += 1) {
    let matchesAt = true
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (lines[at + offset] !== pattern[offset]) {
        matchesAt = false
        break
      }
    }
    if (matchesAt) matches.push(at)
  }
  if (matches.length === 0) {
    throw new Error(
      `Failed to find exact expected lines in ${filePath}:\n${pattern.join("\n")}`,
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `Patch is ambiguous in ${filePath}; include more unchanged context`,
    )
  }
  return matches[0]!
}

export function applyPatchChunksToText(
  original: string,
  chunks: readonly ApplyPatchChunk[],
  filePath: string,
): string {
  const bom = original.startsWith("\uFEFF") ? "\uFEFF" : ""
  const withoutBom = bom ? original.slice(1) : original
  const lineEnding = withoutBom.includes("\r\n") ? "\r\n" : "\n"
  const normalized = withoutBom.replace(/\r\n?/gu, "\n")
  const finalNewline = normalized.endsWith("\n")
  const lines = normalized.split("\n")
  if (finalNewline) lines.pop()

  let cursor = 0
  for (const chunk of chunks) {
    if (chunk.changeContext !== undefined) {
      cursor =
        findUniqueSequence(
          lines,
          [chunk.changeContext],
          cursor,
          false,
          filePath,
        ) + 1
    }
    const at =
      chunk.oldLines.length === 0
        ? chunk.changeContext === undefined
          ? lines.length
          : cursor
        : findUniqueSequence(
            lines,
            chunk.oldLines,
            cursor,
            chunk.endOfFile,
            filePath,
          )
    lines.splice(at, chunk.oldLines.length, ...chunk.newLines)
    cursor = at + chunk.newLines.length
  }

  const body = lines.join(lineEnding)
  return `${bom}${body}${finalNewline ? lineEnding : ""}`
}

const schema = z.object({
  patch: z.string().min(1),
})

export const applyPatchParameters = schema

function diffPreview(
  before: string,
  after: string,
  beforePath: string,
  afterPath: string,
): string {
  return diff.createTwoFilesPatch(
    beforePath,
    afterPath,
    before,
    after,
    "",
    "",
    { context: 3 },
  )
}

function boundedCombinedDiff(parts: readonly string[]): string {
  const lines = parts.join("\n").split(/\r?\n/u)
  let value =
    lines.length > MAX_DIFF_PREVIEW_LINES
      ? `${lines.slice(0, MAX_DIFF_PREVIEW_LINES).join("\n")}\n… (diff truncated)`
      : lines.join("\n")
  if (value.length > MAX_DIFF_PREVIEW_CHARS) {
    value =
      `${value.slice(0, MAX_DIFF_PREVIEW_CHARS)}\n… (diff truncated)`
  }
  return value
}

function patchOperationSummary(operation: ApplyPatchOperation): string {
  if (operation.type === "add") return `A ${operation.path}`
  if (operation.type === "delete") return `D ${operation.path}`
  if (operation.movePath) {
    return `R ${operation.path} -> ${operation.movePath}`
  }
  return `M ${operation.path}`
}

async function readCaptured(
  ctx: ToolContext,
  filePath: string,
): Promise<CapturedFileState> {
  if (typeof ctx.host.readFileState !== "function") {
    throw new Error("host cannot capture durable file state")
  }
  return ctx.host.readFileState(filePath)
}

async function refreshChangedPaths(
  ctx: ToolContext,
  paths: readonly string[],
): Promise<void> {
  const refreshNow = ctx.indexer?.refreshFileNow
  const refresh = ctx.indexer?.refreshFile
  if (!refreshNow && !refresh) return
  for (const filePath of paths) {
    const absolute = await ctx.host.resolvePath(filePath, "read")
      .catch(() => undefined)
    if (!absolute) continue
    if (refreshNow) {
      await refreshNow.call(ctx.indexer, absolute).catch(() => undefined)
    } else if (refresh) {
      await refresh.call(ctx.indexer, absolute).catch(() => undefined)
    }
  }
}

export const applyPatchTool: ToolDef<z.infer<typeof schema>> = {
  name: "ApplyPatch",
  searchHint:
    "apply a Codex-style multi-file patch, add update move or delete files atomically",
  description: `Apply one strict Codex-style patch across one or more files.

Use this when a coherent change spans multiple files or needs add/update/delete/move operations in one reviewable action. The entire patch is validated and content-matched before any file is changed.

Format:
*** Begin Patch
*** Add File: path
+new line
*** Update File: path
*** Move to: optional/new/path
@@ optional unique context line
-old line
+new line
*** Delete File: path
*** End Patch

Every add line must start with '+'. Every update line must start with ' ', '+', or '-'. Include enough unchanged context to make each replacement unambiguous.`,
  parameters: schema,
  requiresApproval: true,

  async execute({ patch }, ctx): Promise<ToolResult> {
    if (
      !ctx.changeSetService ||
      !ctx.executionIdentity ||
      typeof ctx.host.readFileState !== "function" ||
      typeof ctx.host.applyFileMutation !== "function"
    ) {
      return {
        success: false,
        output:
          "ApplyPatch requires durable ChangeSet support from the active host.",
      }
    }

    let parsed: ParsedApplyPatch
    try {
      parsed = parseApplyPatch(patch)
    } catch (error) {
      return {
        success: false,
        output:
          "ApplyPatch verification failed: " +
          (error instanceof Error ? error.message : String(error)),
      }
    }

    const files: ChangeProposalFile[] = []
    const previews: string[] = []
    const changedPaths: string[] = []
    let added = 0
    let removed = 0
    try {
      for (const operation of parsed.operations) {
        if (operation.type === "add") {
          const original = await readCaptured(ctx, operation.path)
          if (original.exists) {
            throw new Error(
              `Cannot add existing file: ${operation.path}`,
            )
          }
          const stats = exactLineDiffStats("", operation.content)
          added += stats.added
          removed += stats.removed
          previews.push(
            diffPreview("", operation.content, operation.path, operation.path),
          )
          files.push({
            path: operation.path,
            expected: { exists: false },
            after: { exists: true, content: operation.content },
            hunks: buildDurableChangeHunks("", operation.content),
            binary: false,
          })
          changedPaths.push(operation.path)
          continue
        }

        const original = await readCaptured(ctx, operation.path)
        if (!original.exists) {
          throw new Error(`File not found: ${operation.path}`)
        }
        if (operation.type === "delete") {
          let beforeText: string | null
          try {
            beforeText = capturedText(original)
          } catch {
            beforeText = null
          }
          if (beforeText === null) {
            previews.push(`Binary file deleted: ${operation.path}`)
          } else {
            const stats = exactLineDiffStats(beforeText, "")
            added += stats.added
            removed += stats.removed
            previews.push(
              diffPreview(beforeText, "", operation.path, operation.path),
            )
          }
          files.push({
            path: operation.path,
            expected: capturedStatePrecondition(original),
            after: { exists: false },
            hunks:
              beforeText === null
                ? []
                : buildDurableChangeHunks(beforeText, ""),
            binary: beforeText === null,
            ...(beforeText === null
              ? {
                  omission: {
                    reason: "binary" as const,
                    detail:
                      "Deleted file is not valid UTF-8; exact bytes remain in the durable blob store.",
                  },
                }
              : {}),
          })
          changedPaths.push(operation.path)
          continue
        }

        const beforeText = capturedText(original)
        if (beforeText === null) {
          throw new Error(`File not found: ${operation.path}`)
        }
        const afterText = applyPatchChunksToText(
          beforeText,
          operation.chunks,
          operation.path,
        )
        if (afterText === beforeText && !operation.movePath) {
          throw new Error(`Patch makes no changes to ${operation.path}`)
        }
        const stats = exactLineDiffStats(beforeText, afterText)
        added += stats.added
        removed += stats.removed
        previews.push(
          diffPreview(
            beforeText,
            afterText,
            operation.path,
            operation.movePath ?? operation.path,
          ),
        )
        files.push({
          path: operation.movePath ?? operation.path,
          ...(operation.movePath ? { oldPath: operation.path } : {}),
          expected: capturedStatePrecondition(original),
          after: {
            exists: true,
            content: afterText,
            mode: original.mode,
          },
          hunks: buildDurableChangeHunks(beforeText, afterText),
          binary: false,
        })
        changedPaths.push(operation.path)
        if (operation.movePath) changedPaths.push(operation.movePath)
      }
    } catch (error) {
      return {
        success: false,
        output:
          "ApplyPatch verification failed: " +
          (error instanceof Error ? error.message : String(error)),
      }
    }

    const summary = parsed.operations.map(patchOperationSummary).join("\n")
    const durable = await applyDurableFileChangeSet(ctx, {
      toolName: "ApplyPatch",
      files,
      operationLabel: `apply patch to ${files.length} file(s)`,
      deniedOutput: "User denied the multi-file patch",
      approvalRequired:
        ctx.fileEditApproval?.required ??
        !ctx.config.permissions.autoApproveWrite,
      approval: {
        description:
          `${ctx.fileEditApproval?.permissionRule ? "[Permission Rule] " : ""}` +
          `Apply patch to ${files.length} file(s)`,
        content: summary,
        diff: boundedCombinedDiff(previews),
        diffStats: { added, removed },
      },
    })
    if (!durable) {
      return {
        success: false,
        output: "Durable ChangeSet support became unavailable.",
      }
    }
    if (!durable.success) return durable

    await refreshChangedPaths(ctx, changedPaths)
    return {
      success: true,
      output: `Success. Updated the following files:\n${summary}`,
      metadata: {
        addedLines: added,
        removedLines: removed,
        patchFiles: parsed.operations.map(patchOperationSummary),
        ...durable.metadata,
      },
    }
  },
}
