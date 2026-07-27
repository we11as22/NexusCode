/**
 * Global data directory for NexusCode (Kilo-style: terminal outputs and large tool output
 * live outside the project so the project tree stays clean).
 *
 * - Background run logs: <data>/run/run_<ts>.log
 * - Large/truncated output:
 *   <data>/tool-output/workspace_<hash>/session_<hash>/artifact_<uuid>.out
 */
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"
import { createHash } from "node:crypto"

export function getNexusDataDir(): string {
  return process.env.NEXUS_DATA_HOME || path.join(os.homedir(), ".nexus", "data")
}

export function getToolOutputDir(): string {
  return path.join(getNexusDataDir(), "tool-output")
}

export function getToolOutputWorkspaceDir(cwd: string): string {
  const canonicalWorkspace = canonicalDataWorkspaceRoot(cwd)
  const workspace = createHash("sha256")
    .update(canonicalWorkspace, "utf8")
    .digest("hex")
    .slice(0, 32)
  return path.join(getToolOutputDir(), `workspace_${workspace}`)
}

/**
 * Artifact ownership must use the same real workspace identity as session
 * storage. Otherwise `/var/...` and its `/private/var/...` real path hash to
 * different roots on macOS and deletion can never find the owned artifact.
 */
export function canonicalDataWorkspaceRoot(cwd: string): string {
  const resolved = path.resolve(cwd)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

/**
 * Keep large result artifacts in an opaque, session-owned directory. Hashing
 * prevents path traversal and avoids leaking raw session identifiers into the
 * filesystem while remaining deterministic across process restarts.
 */
export function getToolOutputSessionDir(
  cwd: string,
  sessionId: string,
): string {
  const owner = createHash("sha256")
    .update(sessionId, "utf8")
    .digest("hex")
    .slice(0, 32)
  return path.join(getToolOutputWorkspaceDir(cwd), `session_${owner}`)
}

export function getRunLogsDir(): string {
  return path.join(getNexusDataDir(), "run")
}
