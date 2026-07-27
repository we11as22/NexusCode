import * as fsp from "node:fs/promises"
import * as path from "node:path"
import type { CheckpointEntry } from "../types.js"
import { getSessionsDir } from "../session/storage.js"
import {
  atomicWriteFile,
  withFileLock,
} from "../storage/durable-fs.js"

const CHECKPOINTS_FILENAME = "checkpoints.json"

export interface CheckpointStorageOptions {
  /** Embedded-host/test override; defaults to `~/.nexus`. */
  homeDir?: string
}

/**
 * Persist checkpoint entries for a session (CLI use: after run or on each commit).
 * Stored under ~/.nexus/sessions/{cwdHash}/checkpoints.json keyed by sessionId.
 */
export async function writeCheckpointEntries(
  cwd: string,
  sessionId: string,
  entries: CheckpointEntry[],
  options: CheckpointStorageOptions = {},
): Promise<void> {
  const dir = getSessionsDir(cwd, options.homeDir)
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const filePath = path.join(dir, CHECKPOINTS_FILENAME)
  await withFileLock(filePath, async () => {
    const data = await readCheckpointMap(filePath)
    data[sessionId] = entries
    await atomicWriteFile(
      filePath,
      `${JSON.stringify(data, null, 2)}\n`,
      { mode: 0o600 },
    )
  })
}

/**
 * Load checkpoint entries for a session.
 */
export async function readCheckpointEntries(
  cwd: string,
  sessionId: string,
  options: CheckpointStorageOptions = {},
): Promise<CheckpointEntry[]> {
  const dir = getSessionsDir(cwd, options.homeDir)
  const filePath = path.join(dir, CHECKPOINTS_FILENAME)
  try {
    const data = await readCheckpointMap(filePath)
    const entries = data[sessionId]
    return Array.isArray(entries) ? [...entries] : []
  } catch {
    return []
  }
}

async function readCheckpointMap(
  filePath: string,
): Promise<Record<string, CheckpointEntry[]>> {
  let info
  try {
    info = await fsp.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Checkpoint storage is not a regular file: ${filePath}`)
  }
  const parsed = JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Checkpoint storage is invalid: ${filePath}`)
  }
  return parsed as Record<string, CheckpointEntry[]>
}
