import {
  Session,
  CheckpointTracker,
  readCheckpointEntries,
} from "@nexuscode/core"

export type RestoreType = "task" | "workspace" | "taskAndWorkspace"

/**
 * Resolve checkpoint id to an entry: numeric string = 1-based index, otherwise = hash prefix match.
 */
export function findCheckpointEntry(
  entries: Array<{ hash: string; ts: number; description?: string }>,
  id: string
): { hash: string; ts: number; description?: string } | null {
  const trimmed = id.trim()
  const asNum = parseInt(trimmed, 10)
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= entries.length) {
    return entries[asNum - 1] ?? null
  }
  const match = entries.find((e) => e.hash === trimmed || e.hash.startsWith(trimmed))
  return match ?? null
}

type SessionRestoreTarget = {
  rewindToTimestamp: (timestamp: number) => void
  save: () => Promise<void>
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
  | { ok: true; hash: string; ts: number }
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
      error: `Checkpoint "${checkpointId}" not found. Use "nexus task checkpoints" to list (by index or hash).`,
    }
  }

  const tracker = new CheckpointTracker(sessionId, cwd)
  const ok = await tracker.init()
  if (!ok) {
    return { ok: false, error: "Checkpoint tracker init failed." }
  }

  if (restoreType === "workspace" || restoreType === "taskAndWorkspace") {
    await tracker.resetHead(entry.hash)
  }
  if (restoreType === "task" || restoreType === "taskAndWorkspace") {
    session.rewindToTimestamp(entry.ts)
  }

  await session.save().catch(() => {})
  return { ok: true, hash: entry.hash, ts: entry.ts }
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
    `Restored ${restoreType}: ${result.hash.slice(0, 7)} (${new Date(result.ts).toISOString()})`
  )
}
