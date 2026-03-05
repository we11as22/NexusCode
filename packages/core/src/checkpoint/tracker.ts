import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import { simpleGit, type SimpleGit } from "simple-git"
import { glob } from "glob"
import type { ChangedFile, CheckpointEntry } from "../types.js"
import { hashWorkingDir, validateWorkspacePath, writeExcludesFile } from "./utils.js"

const CHECKPOINT_WARN_MS = 7_000
const GIT_DISABLED_SUFFIX = "_disabled"

/**
 * Shadow git repository for checkpoints (Cline/Roo-Code style).
 * - Shadow repo lives in ~/.nexus/checkpoints/{cwdHash}/.git
 * - core.worktree points to the workspace; no file copy — worktree is the workspace.
 * - saveCheckpoint = stage + commit in shadow; restore = git clean -fd + git reset --hard hash.
 */
export class CheckpointTracker {
  private git: SimpleGit | null = null
  /** Directory containing .git (shadow repo root). */
  private readonly shadowDir: string
  private readonly cwdHash: string
  private initialized = false
  private entries: CheckpointEntry[] = []

  constructor(
    private readonly taskId: string,
    private readonly workspaceRoot: string
  ) {
    this.cwdHash = hashWorkingDir(workspaceRoot)
    this.shadowDir = path.join(os.homedir(), ".nexus", "checkpoints", this.cwdHash)
  }

  private getGit(): SimpleGit {
    if (!this.git) throw new Error("CheckpointTracker not initialized")
    return this.git
  }

  /**
   * Initialize the shadow git repository with worktree = workspaceRoot.
   * Returns false if validation fails, git unavailable, or timeout.
   */
  async init(timeoutMs: number = 15_000): Promise<boolean> {
    if (this.initialized) return true

    const warnTimer = setTimeout(() => {
      console.warn("[nexus] Checkpoints are taking longer than expected to initialize. Large repo?")
    }, CHECKPOINT_WARN_MS)

    try {
      await validateWorkspacePath(this.workspaceRoot)
    } catch (err) {
      console.warn("[nexus] Checkpoint workspace validation failed:", (err as Error).message)
      clearTimeout(warnTimer)
      return false
    }

    try {
      await Promise.race(
        [this.initInternal(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Checkpoint init timed out")), timeoutMs))]
      )
      this.initialized = true
      return true
    } catch (err) {
      console.warn("[nexus] Checkpoint init failed:", (err as Error).message)
      return false
    } finally {
      clearTimeout(warnTimer)
    }
  }

  private async initInternal(): Promise<void> {
    const gitPath = path.join(this.shadowDir, ".git")

    const exists = await fs.access(gitPath).then(() => true).catch(() => false)
    if (exists) {
      this.git = simpleGit(this.shadowDir)
      const worktree = await this.getGit().raw(["config", "core.worktree"])
      const configured = worktree.trim().replace(/\n$/, "")
      if (configured !== this.workspaceRoot) {
        throw new Error(`Checkpoints can only be used in the original workspace: ${configured}`)
      }
      await writeExcludesFile(gitPath)
      return
    }

    await fs.mkdir(this.shadowDir, { recursive: true })
    this.git = simpleGit(this.shadowDir)
    await this.getGit().init()
    await this.getGit().addConfig("core.worktree", this.workspaceRoot)
    await this.getGit().addConfig("user.email", "nexus@local")
    await this.getGit().addConfig("user.name", "NexusCode")
    await this.getGit().addConfig("commit.gpgSign", "false")
    await writeExcludesFile(gitPath)

    await this.addCheckpointFiles()
    try {
      await this.getGit().commit("initial checkpoint", { "--allow-empty": null })
    } catch {
      // empty repo
    }
  }

  /** Stage files in worktree; temporarily renames nested .git dirs so git doesn't treat them as submodules (Cline-style). */
  private async addCheckpointFiles(): Promise<void> {
    await this.renameNestedGitRepos(true)
    try {
      await this.getGit().add([".", "--ignore-errors"])
    } finally {
      await this.renameNestedGitRepos(false)
    }
  }

  private async renameNestedGitRepos(disable: boolean): Promise<void> {
    const pattern = disable ? "**/.git" : `**/.git${GIT_DISABLED_SUFFIX}`
    let entries: string[]
    try {
      entries = await glob(pattern, {
        cwd: this.workspaceRoot,
        dot: true,
        ignore: [".git"],
      })
    } catch {
      return
    }
    entries = entries.filter((rel) => rel !== ".git" && rel !== `.git${GIT_DISABLED_SUFFIX}`)
    for (const rel of entries) {
      const fullPath = path.join(this.workspaceRoot, rel)
      try {
        const st = await fs.stat(fullPath)
        if (!st.isDirectory()) continue
      } catch {
        continue
      }
      const newPath = disable
        ? fullPath + GIT_DISABLED_SUFFIX
        : fullPath.endsWith(GIT_DISABLED_SUFFIX)
          ? fullPath.slice(0, -GIT_DISABLED_SUFFIX.length)
          : fullPath
      try {
        await fs.rename(fullPath, newPath)
      } catch {
        // permissions or in use
      }
    }
  }

  async commit(description?: string): Promise<string> {
    if (!this.initialized) {
      await this.init()
    }
    if (!this.initialized) throw new Error("Checkpoint not initialized")

    await this.addCheckpointFiles()
    let hash: string
    try {
      const result = await this.getGit().commit(description ?? `checkpoint ${Date.now()}`, { "--allow-empty": null, "--no-verify": null })
      hash = (result.commit ?? "").replace(/^HEAD\s+/, "").trim()
    } catch {
      hash = (await this.getGit().revparse(["HEAD"])).trim()
    }
    this.entries.push({ hash, ts: Date.now(), description, messageId: "" })
    return hash
  }

  /**
   * Restore workspace to a checkpoint (Cline/Roo-Code style).
   * Runs git clean -fd then git reset --hard in the shadow repo; worktree = workspace so files are restored in place.
   */
  async resetHead(hash: string): Promise<void> {
    if (!this.initialized) throw new Error("Checkpoint not initialized")
    const cleanHash = hash.startsWith("HEAD ") ? hash.slice(5) : hash.trim()
    await this.getGit().clean(["-f", "-d"])
    await this.getGit().reset(["--hard", cleanHash])
  }

  async getDiff(fromHash: string, toHash?: string): Promise<ChangedFile[]> {
    if (!this.initialized) return []
    const cleanFrom = fromHash.startsWith("HEAD ") ? fromHash.slice(5) : fromHash.trim()
    await this.addCheckpointFiles()
    const diffRange = toHash
      ? `${cleanFrom}..${toHash.startsWith("HEAD ") ? toHash.slice(5) : toHash.trim()}`
      : cleanFrom
    try {
      const diff = await this.getGit().diff(["--name-status", diffRange])
      const files: ChangedFile[] = []
      for (const line of diff.split("\n").filter(Boolean)) {
        const [status, ...parts] = line.split("\t")
        const filePath = parts[0]
        if (!filePath || !status) continue
        let before = ""
        let after = ""
        try {
          before = await this.getGit().show([`${cleanFrom}:${filePath}`]).catch(() => "")
        } catch {}
        if (toHash) {
          const cleanTo = toHash.startsWith("HEAD ") ? toHash.slice(5) : toHash.trim()
          try {
            after = await this.getGit().show([`${cleanTo}:${filePath}`]).catch(() => "")
          } catch {}
        } else {
          try {
            after = await fs.readFile(path.join(this.workspaceRoot, filePath), "utf8")
          } catch {}
        }
        files.push({
          path: filePath,
          before,
          after,
          status: status === "A" ? "added" : status === "D" ? "deleted" : "modified",
        })
      }
      return files
    } catch {
      return []
    }
  }

  getEntries(): CheckpointEntry[] {
    return [...this.entries]
  }
}
