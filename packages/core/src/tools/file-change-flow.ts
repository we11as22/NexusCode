import { requestHostApproval } from "../agent/approval-coordinator.js"
import { hashFileContent } from "../changes/hash.js"
import { diffLines, structuredPatch } from "diff"
import * as path from "node:path"
import type {
  CapturedFileState,
  ChangeHunk,
  ChangeProposalFile,
  ChangeProposalExpectedState,
  ChangeSetRecord,
} from "../changes/types.js"
import type { ToolContext, ToolResult } from "../types.js"

export interface DurableTextFileChangeInput {
  readonly toolName: "Write" | "Edit"
  readonly filePath: string
  readonly original: CapturedFileState
  readonly content: string
  readonly diff: string
  readonly diffStats: {
    readonly added: number
    readonly removed: number
  }
  readonly approvalRequired: boolean
  readonly permissionRule: boolean
  readonly hunks?: readonly ChangeHunk[]
}

export interface DurableFileChangeSetInput {
  readonly toolName: string
  readonly files: readonly ChangeProposalFile[]
  readonly operationLabel: string
  readonly deniedOutput: string
  readonly approvalRequired: boolean
  readonly approval: {
    readonly description: string
    readonly path?: string
    readonly content?: string
    readonly diff?: string
    readonly diffStats?: {
      readonly added: number
      readonly removed: number
    }
  }
}

function changedLineCount(value: string): number {
  if (!value) return 0
  const newlineCount = value.match(/\n/gu)?.length ?? 0
  return newlineCount + (value.endsWith("\n") ? 0 : 1)
}

/** Exact line multiplicity for approval and review surfaces. */
export function exactLineDiffStats(
  before: string,
  after: string,
): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const change of diffLines(before, after)) {
    const count = changedLineCount(change.value)
    if (change.added) added += count
    if (change.removed) removed += count
  }
  return { added, removed }
}

/**
 * Recover exact changed-line counts from canonical unified hunks.
 *
 * Hunk old/new lengths include unchanged context and must never be exposed as
 * additions/removals. The patch body preserves the actual +/- ownership.
 */
export function exactChangeHunkDiffStats(
  hunks: readonly ChangeHunk[],
): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    const lines = hunk.patch.split(/\r?\n/u)
    for (let index = 1; index < lines.length; index++) {
      const line = lines[index] ?? ""
      if (line.startsWith("+")) added += 1
      else if (line.startsWith("-")) removed += 1
    }
  }
  return { added, removed }
}

/**
 * Durable change records are workspace-scoped and therefore store portable
 * relative paths even when a model uses an absolute path accepted by Read.
 */
export function workspaceRelativeChangePath(
  cwd: string,
  filePath: string,
): string {
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, filePath)
  const relative = path.relative(root, absolute)
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Change path is outside the workspace: ${filePath}`)
  }
  return relative.replace(/\\/gu, "/")
}

/**
 * Build canonical unified hunks for the durable proposal hash. UI-oriented
 * line deltas are intentionally a separate projection because they are
 * truncated and cannot prove the exact approved patch.
 */
export function buildDurableChangeHunks(
  before: string,
  after: string,
): readonly ChangeHunk[] {
  return structuredPatch(
    "before",
    "after",
    before,
    after,
    "",
    "",
    { context: 3 },
  ).hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    patch:
      `@@ -${hunk.oldStart},${hunk.oldLines} ` +
      `+${hunk.newStart},${hunk.newLines} @@\n` +
      hunk.lines.join("\n"),
  }))
}

function changeMetadata(record: ChangeSetRecord): Record<string, unknown> {
  return {
    changeSetId: record.id,
    proposalHash: record.proposalHash,
    changeSetState: record.state,
    changeFiles: record.files.map((file) => ({
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      operation: file.operation,
      beforeHash: file.before.hash,
      afterHash: file.after.hash,
      binary: file.binary,
      diffStats: exactChangeHunkDiffStats(file.hunks),
      ...(file.omission ? { omission: file.omission } : {}),
    })),
  }
}

export function capturedStatePrecondition(
  state: CapturedFileState,
): ChangeProposalExpectedState {
  if (!state.exists) return { exists: false }
  const digest = hashFileContent(state.content)
  return {
    exists: true,
    hash: digest.hash,
    byteLength: digest.byteLength,
    mode: state.mode,
  }
}

/**
 * Decode a text-tool input baseline without silently replacing invalid UTF-8
 * bytes. Binary files require a binary-aware tool instead of Write/Edit.
 */
export function capturedText(state: CapturedFileState): string | null {
  if (!state.exists) return null
  const bytes = Buffer.from(state.content)
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(
      "Write/Edit cannot safely modify a file containing invalid UTF-8 bytes",
    )
  }
  return text
}

export async function applyDurableTextFileChange(
  ctx: ToolContext,
  input: DurableTextFileChangeInput,
): Promise<ToolResult | undefined> {
  return applyDurableFileChangeSet(ctx, {
    toolName: input.toolName,
    files: [{
      path: input.filePath,
      expected: capturedStatePrecondition(input.original),
      after: {
        exists: true,
        content: input.content,
        ...(input.original.exists
          ? { mode: input.original.mode }
          : {}),
      },
      hunks: input.hunks ?? [],
      binary: false,
    }],
    operationLabel:
      `${input.toolName === "Write" ? "write" : "edit"} ${input.filePath}`,
    deniedOutput:
      `User denied ${input.toolName === "Write" ? "write to" : "edit of"} ` +
      input.filePath,
    approvalRequired: input.approvalRequired,
    approval: {
      description:
        `${input.permissionRule ? "[Permission Rule] " : ""}` +
        `${input.toolName === "Write" ? "Write to" : "Edit"} ${input.filePath}`,
      path: workspaceRelativeChangePath(ctx.cwd, input.filePath),
      content: input.content,
      diff: input.diff,
      diffStats: input.diffStats,
    },
  })
}

export async function applyDurableFileChangeSet(
  ctx: ToolContext,
  input: DurableFileChangeSetInput,
): Promise<ToolResult | undefined> {
  const service = ctx.changeSetService
  if (!service) return undefined
  if (!ctx.executionIdentity) {
    return {
      success: false,
      output:
        `Failed to ${input.operationLabel}: ` +
        "durable tool execution identity is unavailable",
    }
  }

  let proposed: ChangeSetRecord
  try {
    const files = input.files.map((file) => ({
      ...file,
      path: workspaceRelativeChangePath(ctx.cwd, file.path),
      ...(file.oldPath
        ? { oldPath: workspaceRelativeChangePath(ctx.cwd, file.oldPath) }
        : {}),
    }))
    proposed = await service.propose({
      identity: ctx.executionIdentity,
      files,
    })
  } catch (error) {
    return {
      success: false,
      output:
        `Failed to prepare ${input.operationLabel}: ` +
        (error instanceof Error ? error.message : String(error)),
    }
  }

  let current = proposed
  if (current.state === "applying" || current.state === "reverting") {
    try {
      current = await service.recover(current.id)
    } catch (error) {
      const observed = await service.get(current.id)
      return {
        success: false,
        output:
          `Failed to recover ${input.operationLabel}: ` +
          (error instanceof Error ? error.message : String(error)),
        metadata: changeMetadata(observed ?? current),
      }
    }
  }

  if (input.approvalRequired && current.state === "proposed") {
    let approved = false
    try {
      const decision = await requestHostApproval(
        ctx.host,
        {
          type: "write",
          tool: input.toolName,
          description: input.approval.description,
          ...(input.approval.path
            ? { path: input.approval.path }
            : {}),
          ...(input.approval.content
            ? { content: input.approval.content }
            : {}),
          ...(input.approval.diff ? { diff: input.approval.diff } : {}),
          ...(input.approval.diffStats
            ? { diffStats: input.approval.diffStats }
            : {}),
        },
        ctx.partId ?? ctx.executionIdentity.partId,
        { signal: ctx.signal },
      )
      approved = decision.approved
    } catch {
      approved = false
    }
    if (!approved) {
      const rejected = await service.reject(
        current.id,
        current.proposalHash,
      )
      return {
        success: false,
        output: input.deniedOutput,
        metadata: changeMetadata(rejected),
      }
    }
  }

  try {
    const approved =
      current.state === "proposed"
        ? await service.approve(current.id, current.proposalHash)
        : current
    if (approved.state === "applied" || approved.state === "accepted") {
      return {
        success: true,
        output: "",
        metadata: changeMetadata(approved),
      }
    }
    if (approved.state !== "approved") {
      return {
        success: false,
        output:
          `Cannot ${input.operationLabel}: ` +
          `durable change set is ${approved.state}`,
        metadata: changeMetadata(approved),
      }
    }
    const applied = await service.apply(approved.id)
    if (applied.state !== "applied" && applied.state !== "accepted") {
      return {
        success: false,
        output:
          `Failed to ${input.operationLabel}: durable change set recovered as ${applied.state}`,
        metadata: changeMetadata(applied),
      }
    }
    return {
      success: true,
      output: "",
      metadata: changeMetadata(applied),
    }
  } catch (error) {
    const observed = await service.get(proposed.id)
    return {
      success: false,
      output:
        `Failed to ${input.operationLabel}: ` +
        (error instanceof Error ? error.message : String(error)),
      metadata: changeMetadata(observed ?? proposed),
    }
  }
}
