import {
  Session,
  CheckpointTracker,
  readCheckpointEntries,
} from "@nexuscode/core"

export type RestoreType = "task" | "workspace" | "taskAndWorkspace"

/**
 * Resolve checkpoint id to an entry: numeric string = 1-based index, otherwise = hash prefix match.
 */
function findCheckpointEntry(
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
  const entries = await readCheckpointEntries(cwd, sessionId)
  if (entries.length === 0) {
    console.error("[nexus] No checkpoints for this session.")
    process.exit(1)
  }

  const entry = findCheckpointEntry(entries, checkpointId)
  if (!entry) {
    console.error(
      `[nexus] Checkpoint "${checkpointId}" not found. Use "nexus task checkpoints" to list (by index or hash).`
    )
    process.exit(1)
  }

  const session = await Session.resume(sessionId, cwd)
  if (!session) {
    console.error("[nexus] Session not found.")
    process.exit(1)
  }

  const tracker = new CheckpointTracker(sessionId, cwd)
  const ok = await tracker.init()
  if (!ok) {
    console.error("[nexus] Checkpoint tracker init failed.")
    process.exit(1)
  }

  if (restoreType === "workspace" || restoreType === "taskAndWorkspace") {
    await tracker.resetHead(entry.hash)
  }
  if (restoreType === "task" || restoreType === "taskAndWorkspace") {
    session.rewindToTimestamp(entry.ts)
  }

  await session.save()
  console.log(
    `Restored ${restoreType}: ${entry.hash.slice(0, 7)} (${new Date(entry.ts).toISOString()})`
  )
}
