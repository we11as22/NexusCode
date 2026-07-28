import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import { simpleGit, type SimpleGit } from "simple-git"
import { glob } from "glob"
import type { ChangedFile, CheckpointEntry } from "../types.js"
import { hashWorkingDir, validateWorkspacePath, writeExcludesFile } from "./utils.js"
import { readCheckpointEntries, writeCheckpointEntries } from "./storage.js"

const CHECKPOINT_WARN_MS = 7_000
const MAX_NESTED_REPOSITORIES = 512

export interface CheckpointTrackerOptions {
  /** Isolated Nexus home for embedded hosts/tests. */
  homeDir?: string
}

/**
 * Read-only shadow history for checkpoint previews.
 * - Shadow repo lives in ~/.nexus/checkpoints/{cwdHash}/.git
 * - core.worktree points to the workspace; no file copy — worktree is the workspace.
 * - Workspace restoration is intentionally delegated to durable ChangeSet
 *   ownership; this tracker never cleans or resets a user worktree.
 */
export class CheckpointTracker {
  private git: SimpleGit | null = null
  /** Directory containing .git (shadow repo root). */
  private readonly shadowDir: string
  private readonly cwdHash: string
  private initialized = false
  private entries: CheckpointEntry[] = []
  private operationQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly taskId: string,
    private readonly workspaceRoot: string,
    private readonly options: CheckpointTrackerOptions = {},
  ) {
    this.cwdHash = hashWorkingDir(workspaceRoot)
    this.shadowDir = path.join(
      options.homeDir ?? path.join(os.homedir(), ".nexus"),
      "checkpoints",
      this.cwdHash,
    )
  }

  private getGit(): SimpleGit {
    if (!this.git) throw new Error("CheckpointTracker not initialized")
    return this.git
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation)
    this.operationQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
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
      await this.refreshCheckpointExcludes(gitPath)
      this.entries = await readCheckpointEntries(
        this.workspaceRoot,
        this.taskId,
        { homeDir: this.options.homeDir },
      ).catch(() => [])
      return
    }

    await fs.mkdir(this.shadowDir, { recursive: true })
    this.git = simpleGit(this.shadowDir)
    await this.getGit().init()
    await this.getGit().addConfig("core.worktree", this.workspaceRoot)
    await this.getGit().addConfig("user.email", "nexus@local")
    await this.getGit().addConfig("user.name", "NexusCode")
    await this.getGit().addConfig("commit.gpgSign", "false")
    await this.refreshCheckpointExcludes(gitPath)
    this.entries = await readCheckpointEntries(
      this.workspaceRoot,
      this.taskId,
      { homeDir: this.options.homeDir },
    ).catch(() => [])

    await this.addCheckpointFiles()
    try {
      await this.getGit().commit("initial checkpoint", { "--allow-empty": null })
    } catch {
      // empty repo
    }
  }

  /**
   * Stage preview files without ever touching nested repository metadata.
   * Nested repositories are excluded as complete roots; old shadow indexes
   * are migrated by removing those paths from the index only.
   */
  private async addCheckpointFiles(): Promise<void> {
    const gitPath = path.join(this.shadowDir, ".git")
    const nestedRoots = await this.refreshCheckpointExcludes(gitPath)
    if (nestedRoots.length > 0) {
      await this.getGit().raw([
        "rm",
        "-r",
        "-f",
        "--cached",
        "--ignore-unmatch",
        "--",
        ...nestedRoots,
      ])
    }
    await this.getGit().add([".", "--ignore-errors"])
  }

  private async refreshCheckpointExcludes(
    gitPath: string,
  ): Promise<string[]> {
    const markers = await glob("**/.git", {
      cwd: this.workspaceRoot,
      dot: true,
      ignore: [
        ".git",
        "node_modules/**",
        ".nexus/**",
        "dist/**",
        "build/**",
        ".next/**",
        ".nuxt/**",
        "coverage/**",
      ],
    })
    const roots = [
      ...new Set(
        markers
          .map((marker) =>
            path.posix.dirname(marker.replaceAll("\\", "/")),
          )
          .filter((root) => root !== "."),
      ),
    ].sort()
    if (roots.length > MAX_NESTED_REPOSITORIES) {
      throw new Error(
        `Checkpoint preview found more than ${MAX_NESTED_REPOSITORIES} nested repositories`,
      )
    }
    await writeExcludesFile(
      gitPath,
      roots.map((root) => `/${root}/`),
    )
    return roots
  }

  async commit(description?: string): Promise<string> {
    return this.enqueue(() => this.commitInternal(description, ""))
  }

  /**
   * Commit a checkpoint associated with a specific user message.
   * Used by rollback-to-message flow in extension/CLI.
   */
  async commitForMessage(messageId: string, description?: string): Promise<string> {
    return this.enqueue(() => this.commitInternal(description, messageId))
  }

  private async commitInternal(description?: string, messageId: string = ""): Promise<string> {
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
    this.entries.push({ hash, ts: Date.now(), description, messageId })
    await writeCheckpointEntries(
      this.workspaceRoot,
      this.taskId,
      this.entries,
      { homeDir: this.options.homeDir },
    ).catch(() => {})
    return hash
  }

  /** Blanket shadow-Git restore is permanently disabled. */
  async resetHead(_hash: string): Promise<never> {
    throw new Error(
      "Unsafe blanket checkpoint restore is disabled; use durable Nexus change ownership.",
    )
  }

  async getDiff(fromHash: string, toHash?: string): Promise<ChangedFile[]> {
    return this.enqueue(async () => {
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
    })
  }

  getEntries(): CheckpointEntry[] {
    return [...this.entries]
  }
}
