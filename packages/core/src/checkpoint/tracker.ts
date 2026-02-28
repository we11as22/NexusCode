import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import { simpleGit, type SimpleGit } from "simple-git"
import type { ChangedFile, CheckpointEntry } from "../types.js"

const CHECKPOINT_WARN_MS = 7_000

/**
 * Shadow git repository for checkpoints.
 * Uses a separate git repo in ~/.nexus/checkpoints/{task-id}/
 * to snapshot the workspace state without interfering with the project's git.
 */
export class CheckpointTracker {
  private git: SimpleGit
  private readonly shadowRoot: string
  private initialized = false
  private entries: CheckpointEntry[] = []

  constructor(
    private readonly taskId: string,
    private readonly workspaceRoot: string
  ) {
    this.shadowRoot = path.join(os.homedir(), ".nexus", "checkpoints", taskId)
    this.git = simpleGit(this.shadowRoot)
  }

  /**
   * Initialize the shadow git repository.
   * Returns false if workspace is too large or git unavailable.
   */
  async init(timeoutMs: number = 15_000): Promise<boolean> {
    if (this.initialized) return true

    const warnTimer = setTimeout(() => {
      console.warn("[nexus] Checkpoints are taking longer than expected to initialize. Large repo?")
    }, CHECKPOINT_WARN_MS)

    try {
      await Promise.race([
        this.initInternal(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Checkpoint init timed out")), timeoutMs)
        ),
      ])
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
    await fs.mkdir(this.shadowRoot, { recursive: true })

    // Init git repo if not exists
    try {
      await this.git.status()
    } catch {
      await this.git.init()
      await this.git.addConfig("user.email", "nexus@local")
      await this.git.addConfig("user.name", "NexusCode")
    }

    // Copy workspace files to shadow root
    await this.syncWorkspace()

    // Initial commit
    await this.git.add(".")
    try {
      await this.git.commit("initial checkpoint", { "--allow-empty": null })
    } catch {}
  }

  async commit(description?: string): Promise<string> {
    if (!this.initialized) {
      await this.init()
    }
    if (!this.initialized) throw new Error("Checkpoint not initialized")

    await this.syncWorkspace()
    await this.git.add(".")

    let hash: string
    try {
      const result = await this.git.commit(description ?? `checkpoint ${Date.now()}`, { "--allow-empty": null })
      hash = result.commit
    } catch {
      hash = await this.git.revparse(["HEAD"])
    }

    this.entries.push({ hash: hash.trim(), ts: Date.now(), description, messageId: "" })
    return hash.trim()
  }

  async resetHead(hash: string): Promise<void> {
    if (!this.initialized) throw new Error("Checkpoint not initialized")

    // Restore files from checkpoint
    await this.git.checkout([hash, "--", "."])

    // Copy restored files back to workspace
    await this.restoreToWorkspace()
  }

  async getDiff(fromHash: string, toHash?: string): Promise<ChangedFile[]> {
    if (!this.initialized) return []

    try {
      const diff = await this.git.diff([
        "--name-status",
        fromHash,
        toHash ?? "HEAD",
      ])

      const files: ChangedFile[] = []
      for (const line of diff.split("\n").filter(Boolean)) {
        const [status, ...parts] = line.split("\t")
        const filePath = parts[0]
        if (!filePath || !status) continue

        let before = ""
        let after = ""

        try {
          before = await this.git.show([`${fromHash}:${filePath}`]).catch(() => "")
        } catch {}

        try {
          after = await this.git.show([`${toHash ?? "HEAD"}:${filePath}`]).catch(() => "")
        } catch {}

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

  private async syncWorkspace(): Promise<void> {
    const { cp } = await import("node:fs/promises")

    // Copy files excluding .git, node_modules, .nexus/index, .nexus/checkpoints
    const ignore = new Set([".git", "node_modules", ".nexus"])

    await copyDir(this.workspaceRoot, this.shadowRoot, ignore)
  }

  private async restoreToWorkspace(): Promise<void> {
    const ignore = new Set([".git", "node_modules", ".nexus"])
    await copyDir(this.shadowRoot, this.workspaceRoot, ignore)
  }
}

async function copyDir(src: string, dest: string, ignoreNames: Set<string>): Promise<void> {
  const { readdir, copyFile, mkdir, stat } = await import("node:fs/promises")

  await mkdir(dest, { recursive: true })

  const items = await readdir(src).catch(() => [] as string[])
  await Promise.all(
    items.map(async item => {
      if (ignoreNames.has(item)) return
      const srcPath = path.join(src, item)
      const destPath = path.join(dest, item)
      const itemStat = await stat(srcPath).catch(() => null)
      if (!itemStat) return
      if (itemStat.isDirectory()) {
        await copyDir(srcPath, destPath, ignoreNames)
      } else if (itemStat.isFile()) {
        await copyFile(srcPath, destPath).catch(() => {})
      }
    })
  )
}
