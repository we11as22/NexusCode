import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Hash workspace path to a short stable id for shadow dir.
 */
export function hashWorkingDir(workingDir: string): string {
  if (!workingDir) throw new Error("Working directory path cannot be empty")
  let h = 0
  const norm = path.resolve(workingDir)
  for (let i = 0; i < norm.length; i++) {
    h = (h * 31 + norm.charCodeAt(i)) >>> 0
  }
  return Math.abs(h).toString(36).slice(0, 12)
}

/**
 * Validate workspace path for checkpoints.
 * Rejects home, Desktop, Documents, Downloads to avoid accidental data loss.
 */
export async function validateWorkspacePath(workspacePath: string): Promise<void> {
  try {
    await fs.access(workspacePath, fs.constants.R_OK)
  } catch (err) {
    throw new Error(
      `Cannot access workspace directory. Ensure the application has permission to access the workspace. ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const homedir = os.homedir()
  const desktop = path.join(homedir, "Desktop")
  const documents = path.join(homedir, "Documents")
  const downloads = path.join(homedir, "Downloads")
  const resolved = path.resolve(workspacePath)
  if (resolved === homedir) throw new Error("Cannot use checkpoints in home directory")
  if (resolved === desktop) throw new Error("Cannot use checkpoints in Desktop directory")
  if (resolved === documents) throw new Error("Cannot use checkpoints in Documents directory")
  if (resolved === downloads) throw new Error("Cannot use checkpoints in Downloads directory")
}

/** Default exclude patterns for shadow git. */
export const DEFAULT_EXCLUDES = [
  ".git/",
  "node_modules/",
  ".nexus/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  "coverage/",
  "*.lock",
  ".DS_Store",
]

export async function writeExcludesFile(gitPath: string, extraPatterns: string[] = []): Promise<void> {
  const infoDir = path.join(gitPath, "info")
  await fs.mkdir(infoDir, { recursive: true })
  const content = [...DEFAULT_EXCLUDES, ...extraPatterns].join("\n")
  await fs.writeFile(path.join(infoDir, "exclude"), content, "utf8")
}
