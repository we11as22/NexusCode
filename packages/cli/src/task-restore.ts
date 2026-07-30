import {
  Session,
  ChangeSetService,
  FileChangeSetStore,
  canonicalProjectRoot,
  getGlobalConfigDir,
  hashWorkspaceIdentity,
  readCheckpointEntries,
  reapplyRevertedChangeSets,
  revertEffectiveChangeSetsAfter,
  type CheckpointEntry,
  type SessionRecoverySnapshot,
} from "@nexuscode/core"
import { CliHost } from "./host.js"

export type RestoreType = "task" | "workspace" | "taskAndWorkspace"

/**
 * Resolve a displayed checkpoint number. Opaque checkpoint identifiers remain
 * accepted for backwards compatibility, but are not part of the user-facing CLI.
 */
export function findCheckpointEntry(
  entries: readonly CheckpointEntry[],
  id: string
): CheckpointEntry | null {
  const trimmed = id.trim()
  const asNum = parseInt(trimmed, 10)
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= entries.length) {
    return entries[asNum - 1] ?? null
  }
  const match = entries.find((e) => e.hash === trimmed || e.hash.startsWith(trimmed))
  return match ?? null
}

type SessionRestoreTarget = {
  readonly messages: Session["messages"]
  rewindToTimestamp: (timestamp: number) => void
  save: () => Promise<void>
  load: () => Promise<boolean>
  captureRecoverySnapshot: () => SessionRecoverySnapshot
  restoreRecoverySnapshot: (snapshot: SessionRecoverySnapshot) => void
}

/**
 * Apply checkpoint restore to an in-memory session (REPL) or after Session.resume (CLI).
 * Does not call process.exit.
 */
export async function applyCheckpointRestore(
  cwd: string,
  session: SessionRestoreTarget,
  sessionId: string,
  checkpointId: string,
  restoreType: RestoreType
): Promise<
  | {
      ok: true
      hash: string
      ts: number
      revertedChangeSets: number
      revertedPaths: readonly string[]
    }
  | { ok: false; error: string }
> {
  const entries = await readCheckpointEntries(cwd, sessionId)
  if (entries.length === 0) {
    return { ok: false, error: "No checkpoints for this session." }
  }

  const entry = findCheckpointEntry(entries, checkpointId)
  if (!entry) {
    return {
      ok: false,
      error: `Checkpoint "${checkpointId}" not found. Use "nexus task checkpoints" and restore it by its displayed number.`,
    }
  }

  const restoresWorkspace =
    restoreType === "workspace" || restoreType === "taskAndWorkspace"
  const restoresTask =
    restoreType === "task" || restoreType === "taskAndWorkspace"
  if (restoresWorkspace && !entry.messageId) {
    return {
      ok: false,
      error:
        "This legacy checkpoint is preview-only because it has no exact message binding. Chat-only restore remains available.",
    }
  }

  const root = canonicalProjectRoot(cwd)
  const workspaceId = hashWorkspaceIdentity(root)
  const store = new FileChangeSetStore(workspaceId, {
    rootDir: getGlobalConfigDir(),
  })
  const service = new ChangeSetService({
    workspaceId,
    store,
    files: new CliHost(root, () => {}),
  })
  const workspaceResult = restoresWorkspace
    ? await revertEffectiveChangeSetsAfter({
        service,
        sessionId,
        createdAtOrAfter: entry.ts,
      })
    : { status: "reverted" as const, reverted: [] }
  if (workspaceResult.status === "conflicted") {
    return {
      ok: false,
      error:
        "Checkpoint restore stopped without rewinding chat because file ownership conflicted: " +
        workspaceResult.conflicts
          .map((conflict) =>
            `${conflict.paths.join(", ") || conflict.changeSetId}: ${conflict.message}`,
          )
          .join("; "),
    }
  }

  if (restoresTask) {
    const recovery = session.captureRecoverySnapshot()
    session.rewindToTimestamp(entry.ts)
    try {
      await session.save()
    } catch (saveError) {
      let persisted = false
      try {
        persisted =
          (await session.load()) &&
          session.messages.every((message) => message.ts <= entry.ts)
      } catch {
        persisted = false
      }
      if (!persisted) {
        session.restoreRecoverySnapshot(recovery)
        const compensation = await reapplyRevertedChangeSets({
          service,
          reverted: workspaceResult.reverted,
        })
        const compensationDetail =
          compensation.conflicts.length === 0
            ? "File changes were returned to their pre-restore state."
            : "File compensation conflicts: " +
              compensation.conflicts
                .map((conflict) =>
                  `${conflict.paths.join(", ") || conflict.changeSetId}: ${conflict.message}`,
                )
                .join("; ")
        return {
          ok: false,
          error:
            "Checkpoint chat rewind could not be persisted; chat was restored in memory. " +
            `${compensationDetail} Save error: ${
              saveError instanceof Error
                ? saveError.message
                : String(saveError)
            }`,
        }
      }
    }
  }

  return {
    ok: true,
    hash: entry.hash,
    ts: entry.ts,
    revertedChangeSets: workspaceResult.reverted.length,
    revertedPaths: workspaceResult.reverted.flatMap((record) =>
      record.files.map((file) => file.path),
    ),
  }
}

/**
 * Run task restore (Cline 1:1): load session and checkpoint entries, find entry by id,
 * init tracker, then restore workspace and/or task per type.
 */
export async function runTaskRestore(
  cwd: string,
  sessionId: string,
  checkpointId: string,
  restoreType: RestoreType
): Promise<void> {
  const session = await Session.resume(sessionId, cwd)
  if (!session) {
    console.error("[nexus] Session not found.")
    process.exit(1)
  }

  const result = await applyCheckpointRestore(
    cwd,
    session,
    sessionId,
    checkpointId,
    restoreType
  )
  if (!result.ok) {
    console.error(`[nexus] ${result.error}`)
    process.exit(1)
  }

  console.log(
    `Restored ${restoreType} to checkpoint #${checkpointId} ` +
    `(${new Date(result.ts).toISOString()}); reverted ` +
    `${result.revertedChangeSets} Nexus-owned change set(s).`
  )
}
