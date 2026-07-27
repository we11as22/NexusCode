import * as fs from "node:fs"
import * as path from "node:path"

import { getToolOutputSessionDir } from "../data-dir.js"
import { TOOL_OUTPUT_ARTIFACT_FILE_PATTERN } from "./tool-output-format.js"
import { listToolSpillsForWorkspace } from "./tool-output-registry.js"

const DEFAULT_DELETE_BATCH_SIZE = 2_048

export class ToolOutputCleanupIncompleteError extends Error {
  constructor(
    readonly sessionId: string,
    readonly deletedArtifacts: number,
  ) {
    super(
      `Tool-output cleanup for ${sessionId} reached its bounded batch limit after deleting ${deletedArtifacts} artifacts; retry the session deletion.`,
    )
    this.name = "ToolOutputCleanupIncompleteError"
  }
}

export class ToolOutputReferenceProtectionIncompleteError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `Tool-output references could not be scanned safely while deleting ${sessionId}; retry the session deletion after repairing session storage.`,
    )
    this.name = "ToolOutputReferenceProtectionIncompleteError"
  }
}

/**
 * Delete one bounded batch from an exact session-owned artifact directory.
 *
 * Live capabilities projected into another session are retained. The
 * transcript remains the retry ledger: callers invoke this before removing
 * the JSONL journal, so a bounded/incomplete pass is safely retryable.
 */
export async function deleteToolOutputArtifactsOwnedBySession(input: {
  cwd: string
  sessionId: string
  maxArtifacts?: number
  protectedArtifacts?: ReadonlySet<string>
  protectAll?: boolean
}): Promise<{ deletedArtifacts: number; retainedArtifacts: number }> {
  const sessionDir = getToolOutputSessionDir(input.cwd, input.sessionId)
  const maxArtifacts =
    Number.isSafeInteger(input.maxArtifacts) && input.maxArtifacts! > 0
      ? input.maxArtifacts!
      : DEFAULT_DELETE_BATCH_SIZE
  const info = await fs.promises.lstat(sessionDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    },
  )
  if (!info) return { deletedArtifacts: 0, retainedArtifacts: 0 }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      `Refusing to clean unsafe tool-output session directory: ${sessionDir}`,
    )
  }

  const protectedArtifacts = new Set(
    listToolSpillsForWorkspace(input.cwd)
      .filter(
        (entry) =>
          entry.ownerSessionId === input.sessionId &&
          entry.sessionId !== input.sessionId,
      )
      .map((entry) => path.resolve(entry.absolutePath)),
  )
  for (const candidate of input.protectedArtifacts ?? []) {
    protectedArtifacts.add(path.resolve(candidate))
  }

  let handle: fs.Dir
  try {
    handle = await fs.promises.opendir(sessionDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { deletedArtifacts: 0, retainedArtifacts: 0 }
    }
    throw error
  }

  let scannedArtifacts = 0
  let deletedArtifacts = 0
  let retainedArtifacts = 0
  let hasMoreArtifacts = false
  try {
    for await (const entry of handle) {
      if (!TOOL_OUTPUT_ARTIFACT_FILE_PATTERN.test(entry.name)) continue
      if (input.protectAll) {
        throw new ToolOutputReferenceProtectionIncompleteError(
          input.sessionId,
        )
      }
      const candidate = path.join(sessionDir, entry.name)
      if (protectedArtifacts.has(path.resolve(candidate))) {
        retainedArtifacts += 1
        continue
      }
      if (scannedArtifacts >= maxArtifacts) {
        hasMoreArtifacts = true
        break
      }
      scannedArtifacts += 1
      const candidateInfo = await fs.promises.lstat(candidate).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        },
      )
      if (!candidateInfo) continue
      if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile()) {
        throw new Error(
          `Refusing to remove unsafe tool-output artifact entry: ${candidate}`,
        )
      }
      await fs.promises.unlink(candidate)
      deletedArtifacts += 1
    }
  } finally {
    await handle.close().catch(() => undefined)
  }

  if (hasMoreArtifacts) {
    throw new ToolOutputCleanupIncompleteError(
      input.sessionId,
      deletedArtifacts,
    )
  }
  await fs.promises.rmdir(sessionDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error
  })
  return { deletedArtifacts, retainedArtifacts }
}
