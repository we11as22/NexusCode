import * as fsp from "node:fs/promises"
import * as path from "node:path"
import type { CheckpointEntry } from "../types.js"
import { getSessionsDir } from "../session/storage.js"

const CHECKPOINTS_FILENAME = "checkpoints.json"

/**
 * Persist checkpoint entries for a session (CLI use: after run or on each commit).
 * Stored under ~/.nexus/sessions/{cwdHash}/checkpoints.json keyed by sessionId.
 */
export async function writeCheckpointEntries(
  cwd: string,
  sessionId: string,
  entries: CheckpointEntry[]
): Promise<void> {
  const dir = getSessionsDir(cwd)
  await fsp.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, CHECKPOINTS_FILENAME)
  let data: Record<string, CheckpointEntry[]> = {}
  try {
    const raw = await fsp.readFile(filePath, "utf8")
    data = JSON.parse(raw) as Record<string, CheckpointEntry[]>
  } catch {
    // File missing or invalid
  }
  data[sessionId] = entries
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf8")
}

/**
 * Load checkpoint entries for a session.
 */
export async function readCheckpointEntries(
  cwd: string,
  sessionId: string
): Promise<CheckpointEntry[]> {
  const dir = getSessionsDir(cwd)
  const filePath = path.join(dir, CHECKPOINTS_FILENAME)
  try {
    const raw = await fsp.readFile(filePath, "utf8")
    const data = JSON.parse(raw) as Record<string, CheckpointEntry[]>
    const entries = data[sessionId]
    return Array.isArray(entries) ? [...entries] : []
  } catch {
    return []
  }
}
