import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as readline from "node:readline"
import { execa } from "execa"
import {
  authorizeNetworkRequest as authorizePublicNetworkRequest,
  approvalGrantKey,
  grantWorkspaceAuthority,
  resolveAuthorizedWorkspacePath,
} from "@nexuscode/core"
import type {
  AgentEvent,
  ApprovalAction,
  AuthorizedNetworkRequest,
  DiagnosticItem,
  HostNetworkRequest,
  HostPathAccess,
  HostReadFileOptions,
  IHost,
  McpAuthRequest,
  McpAuthResult,
  PermissionResult,
  WorkspaceAuthorityStoreOptions,
} from "@nexuscode/core"

const DENY_EXTENSIONS = new Set([".env", ".key", ".pem", ".crt", ".p12", ".pfx"])
const DENY_PATHS = [".env", "secrets", ".ssh", "id_rsa", "id_ed25519"]

export interface NonInteractiveApprovalPolicy {
  read?: boolean
}

export function resolveNonInteractiveApproval(
  action: ApprovalAction,
  policy: NonInteractiveApprovalPolicy,
): PermissionResult {
  return {
    approved: action.type === "read" && policy.read === true,
  }
}

export function shouldAutoApprovePrint(
  dangerouslySkipPermissions: boolean | undefined,
): boolean {
  return dangerouslySkipPermissions === true
}

export interface CliSavedFileEdit {
  path: string
  originalContent: string
  newContent: string
  isNewFile: boolean
}

export interface CliFileRevertResult {
  reverted: string[]
  conflicts: Array<{ path: string; reason: string }>
}

/**
 * CLI host adapter — terminal-based approvals, output, and security guards.
 * When tuiApprovalRef is provided, showApprovalDialog does NOT use readline (TUI handles input).
 */
export class CliHost implements IHost {
  readonly cwd: string
  private eventEmitter: (event: AgentEvent) => void
  private autoApprove: boolean
  /** When set, approval is resolved via this ref (TUI mode — no readline). */
  private tuiApprovalRef?: { current: ((r: PermissionResult) => void) | null }
  private alwaysApproved = new Set<string>()
  private nonInteractiveDiagnosticEmitted = false
  private pendingFileEdits = new Map<string, { originalContent: string; newContent: string; isNewFile: boolean }>()
  /** File edits from the current assistant turn (path → originalContent + isNewFile). Cleared on next assistant_message_started. */
  private turnFileEdits: CliSavedFileEdit[] = []
  /** Previous turn's edits; used by revertLastTurn to restore files. */
  private previousTurnFileEdits: CliSavedFileEdit[] = []
  /**
   * A successfully restored file batch is held here until the matching
   * conversation rewind is durably saved. This makes CLI undo a two-phase
   * operation instead of silently splitting filesystem and chat state.
   */
  private pendingLastTurnFileRevert: CliSavedFileEdit[] = []

  constructor(
    cwd: string,
    onEvent: (event: AgentEvent) => void,
    autoApprove = false,
    tuiApprovalRef?: { current: ((r: PermissionResult) => void) | null },
    private readonly nonInteractivePolicy: NonInteractiveApprovalPolicy = {},
    private readonly authorityStoreOptions: WorkspaceAuthorityStoreOptions = {},
  ) {
    this.cwd = cwd
    this.eventEmitter = onEvent
    this.autoApprove = autoApprove
    this.tuiApprovalRef = tuiApprovalRef
  }

  async resolvePath(
    filePath: string,
    access: HostPathAccess,
  ): Promise<string> {
    const absPath = this.resolve(filePath)
    this.checkPathSecurity(absPath, access === "list" ? "read" : access)
    return absPath
  }

  async authorizeNetworkRequest(
    request: HostNetworkRequest,
  ): Promise<AuthorizedNetworkRequest> {
    return authorizePublicNetworkRequest(request)
  }

  async readFile(
    filePath: string,
    options: HostReadFileOptions = {},
  ): Promise<string> {
    const absPath = this.resolve(filePath)
    this.checkPathSecurity(absPath, "read")
    const stat = await fs.stat(absPath)
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory: ${filePath}`)
    }
    if (
      typeof options.maxBytes === "number" &&
      Number.isSafeInteger(options.maxBytes) &&
      options.maxBytes >= 0 &&
      stat.size > options.maxBytes
    ) {
      throw new Error(
        `File exceeds the ${options.maxBytes}-byte host read limit`,
      )
    }
    return fs.readFile(absPath, "utf8")
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const absPath = this.resolve(filePath)
    this.checkPathSecurity(absPath, "write")
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    // Atomic write via tmp file
    const tmp = absPath + ".nexus_tmp"
    await fs.writeFile(tmp, content, "utf8")
    await fs.rename(tmp, absPath)
  }

  async deleteFile(filePath: string): Promise<void> {
    const absPath = this.resolve(filePath)
    this.checkPathSecurity(absPath, "delete")
    await fs.unlink(absPath)
  }

  async exists(filePath: string): Promise<boolean> {
    const absPath = this.resolve(filePath)
    return fs.access(absPath).then(() => true).catch(() => false)
  }

  async showDiff(filePath: string, before: string, after: string): Promise<boolean> {
    // In CLI we show inline diff via execute_command or tool output
    // Return true to proceed with the write
    return true
  }

  async runCommand(command: string, cwd: string, signal?: AbortSignal) {
    const commandCwd = this.resolve(cwd || this.cwd)
    const result = await execa(command, {
      shell: true,
      cwd: commandCwd,
      reject: false,
      timeout: 120_000,
      cancelSignal: signal,
    })
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    }
  }

  async showApprovalDialog(
    action: ApprovalAction,
    signal?: AbortSignal,
  ): Promise<PermissionResult> {
    if (signal?.aborted) return { approved: false }
    if (this.autoApprove) return { approved: true }

    if (!this.tuiApprovalRef && !process.stdin.isTTY) {
      const result = resolveNonInteractiveApproval(
        action,
        this.nonInteractivePolicy,
      )
      if (!result.approved && !this.nonInteractiveDiagnosticEmitted) {
        this.nonInteractiveDiagnosticEmitted = true
        process.stderr.write(
          "[nexus] Non-interactive mode denied a privileged action. Use an interactive terminal, or --dangerously-skip-permissions only inside its validated offline container.\n",
        )
      }
      return result
    }

    // Read ops always auto-approved in CLI
    if (action.type === "read") return { approved: true }

    // Check "always approve" memory for this session
    const alwaysKey = approvalGrantKey(action)
    if (this.alwaysApproved.has(alwaysKey)) return { approved: true }

    // TUI mode: don't use readline — return Promise resolved by TUI when user types y/n/a/s
    if (this.tuiApprovalRef) {
      return new Promise<PermissionResult>(resolve => {
        let settled = false
        const finish = (result: PermissionResult) => {
          if (settled) return
          settled = true
          signal?.removeEventListener("abort", onAbort)
          if (this.tuiApprovalRef?.current === resolver) {
            this.tuiApprovalRef.current = null
          }
          if (result.alwaysApprove) this.alwaysApproved.add(alwaysKey)
          if (result.skipAll) this.autoApprove = true
          resolve(result)
        }
        const resolver = (result: PermissionResult) => finish(result)
        const onAbort = () => finish({ approved: false })
        signal?.addEventListener("abort", onAbort, { once: true })
        if (signal?.aborted) onAbort()
        if (!settled) this.tuiApprovalRef!.current = resolver
      })
    }

    // Non-TUI: use readline (e.g. --print or headless)
    return new Promise(resolve => {
      let settled = false
      let rl: readline.Interface | undefined
      const finish = (result: PermissionResult) => {
        if (settled) return
        settled = true
        signal?.removeEventListener("abort", onAbort)
        rl?.close()
        resolve(result)
      }
      const onAbort = () => finish({ approved: false })
      const lines: string[] = [""]

      if (action.type === "execute") {
        lines.push(`\x1b[1;33m⌨️  Bash\x1b[0m`)
        const cmd = action.content || action.description.replace(/^Run:\s*/i, "")
        lines.push(`  \x1b[36m${cmd}\x1b[0m`)
      } else if (action.type === "write") {
        lines.push(`\x1b[1;32m✏ File write requested:\x1b[0m`)
        lines.push(`  \x1b[36m${action.description}\x1b[0m`)
        if (action.diff) {
          const diffPreview = action.diff.split("\n").slice(0, 40)
          for (const line of diffPreview) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
              lines.push(`  \x1b[32m${line}\x1b[0m`)
            } else if (line.startsWith("-") && !line.startsWith("---")) {
              lines.push(`  \x1b[31m${line}\x1b[0m`)
            } else {
              lines.push(`  \x1b[90m${line}\x1b[0m`)
            }
          }
          if (action.diff.includes("(truncated)")) lines.push(`  \x1b[90m...\x1b[0m`)
        } else if (action.content) {
          const preview = action.content.split("\n").slice(0, 5).join("\n")
          lines.push(`  \x1b[90m${preview}\x1b[0m`)
        }
      } else if (action.type === "mcp") {
        lines.push(`\x1b[1;35m🔌 MCP tool call:\x1b[0m`)
        lines.push(`  \x1b[36m${action.description}\x1b[0m`)
      } else if (action.type === "plugin") {
        lines.push(`\x1b[1;35m🧩 Plugin action:\x1b[0m`)
        lines.push(`  \x1b[36m${action.description}\x1b[0m`)
        if (action.warning) lines.push(`  \x1b[33m${action.warning}\x1b[0m`)
      } else if (action.type === "browser") {
        lines.push(`\x1b[1;34m🌐 Public network request:\x1b[0m`)
        lines.push(`  \x1b[36m${action.description}\x1b[0m`)
      } else if (action.type === "doom_loop") {
        lines.push(`\x1b[1;31m⚠ Potential infinite loop detected:\x1b[0m`)
        lines.push(`  \x1b[31m${action.description}\x1b[0m`)
      }

      const optionsLine =
        action.type === "execute"
          ? `\x1b[90m[y] Allow once [n] Deny [a] Always allow [s] Allow all (session) [e] Add to allowed (folder) [i] Say what to do instead\x1b[0m`
          : `\x1b[90m[y] Allow once [n] Deny [a] Always allow [s] Allow all (session) [i] Say what to do instead\x1b[0m`
      lines.push(optionsLine)
      lines.push("")
      process.stdout.write(lines.join("\n"))
      process.stdout.write(`\x1b[1mAllow? \x1b[0m`)

      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: process.stdout.isTTY,
      })
      signal?.addEventListener("abort", onAbort, { once: true })
      if (signal?.aborted) onAbort()

      rl.once("line", (answer: string) => {
        const lower = answer.trim().toLowerCase()
        if (lower === "i" || lower === "instruct") {
          process.stdout.write(`\x1b[90mWhat to do instead? \x1b[0m`)
          rl.once("line", (instruction: string) => {
            finish({
              approved: false,
              whatToDoInstead: instruction.trim() || undefined,
            })
          })
          return
        }
        const addToAllowed = action.type === "execute" && (lower === "e" || lower === "add")
        const approved = ["y", "yes", "a", "always", "s", "skip"].includes(lower) || addToAllowed
        const alwaysApprove = lower === "a" || lower === "always"
        const skipAll = lower === "s" || lower === "skip"

        if (alwaysApprove) {
          this.alwaysApproved.add(alwaysKey)
        }
        if (skipAll) {
          this.autoApprove = true
        }

        finish({
          approved,
          alwaysApprove,
          skipAll,
          addToAllowedCommand: addToAllowed && action.content ? action.content : undefined,
        })
      })

    })
  }

  emit(event: AgentEvent): void {
    this.eventEmitter(event)
  }

  async addAllowedCommand(cwd: string, command: string): Promise<void> {
    const authorizedCwd = this.resolve(cwd || this.cwd)
    const normalized = command.trim().replace(/\s+/g, " ")
    if (!normalized) return
    await grantWorkspaceAuthority(
      authorizedCwd,
      { kind: "command", value: normalized },
      this.authorityStoreOptions,
    )
  }

  async addAllowedPattern(cwd: string, pattern: string): Promise<void> {
    const authorizedCwd = this.resolve(cwd || this.cwd)
    const trimmed = pattern.trim()
    if (!trimmed) return
    await grantWorkspaceAuthority(
      authorizedCwd,
      { kind: "command-pattern", value: trimmed },
      this.authorityStoreOptions,
    )
  }

  async addAllowedMcpTool(cwd: string, toolName: string): Promise<void> {
    const authorizedCwd = this.resolve(cwd || this.cwd)
    const trimmed = toolName.trim()
    if (!trimmed) return
    await grantWorkspaceAuthority(
      authorizedCwd,
      { kind: "mcp-tool", value: trimmed },
      this.authorityStoreOptions,
    )
  }

  async getProblems(): Promise<DiagnosticItem[]> {
    return []
  }

  async requestMcpAuthentication(request: McpAuthRequest): Promise<McpAuthResult> {
    const lines = [
      request.message?.trim() || `Authenticate MCP server "${request.server}".`,
      request.startUrl ? `Open this URL: ${request.startUrl}` : "",
    ].filter(Boolean)
    return {
      success: false,
      ...(request.startUrl ? { pending: true } : {}),
      message: lines.join("\n"),
    }
  }

  async openFileEdit(filePath: string, options: { originalContent: string; newContent: string; isNewFile: boolean }): Promise<void> {
    const key = filePath.replace(/\\/g, "/")
    this.pendingFileEdits.set(key, { originalContent: options.originalContent, newContent: options.newContent, isNewFile: options.isNewFile })
  }

  async saveFileEdit(filePath: string): Promise<void> {
    const key = filePath.replace(/\\/g, "/")
    const pending = this.pendingFileEdits.get(key)
    if (!pending) throw new Error(`No pending file edit for ${filePath}`)
    const absolutePath = this.resolve(filePath)
    this.checkPathSecurity(absolutePath, "write")
    const existing = this.turnFileEdits.find(
      (edit) => edit.path === absolutePath,
    )
    if (
      existing &&
      pending.originalContent !== existing.newContent
    ) {
      throw new Error(
        `File edit conflict: ${absolutePath} changed between agent edits`,
      )
    }
    let currentContent: string | undefined
    try {
      currentContent = await fs.readFile(absolutePath, "utf8")
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error
      }
    }
    if (pending.isNewFile) {
      if (currentContent !== undefined) {
        throw new Error(
          `File edit conflict: ${absolutePath} was created after the diff was prepared`,
        )
      }
    } else if (currentContent !== pending.originalContent) {
      throw new Error(
        `File edit conflict: ${absolutePath} changed after the diff was prepared`,
      )
    }

    await this.writeFile(absolutePath, pending.newContent)
    if (existing) {
      existing.newContent = pending.newContent
    } else {
      this.turnFileEdits.push({
        path: absolutePath,
        originalContent: pending.originalContent,
        newContent: pending.newContent,
        isNewFile: pending.isNewFile,
      })
    }
    this.pendingFileEdits.delete(key)
  }

  /** Call when a new assistant turn starts (e.g. on assistant_message_started). Moves current turn edits to previous. */
  startNewTurn(): void {
    this.previousTurnFileEdits = [...this.turnFileEdits]
    this.turnFileEdits = []
  }

  /** Edits from the last completed assistant turn; used by revertLastTurn to restore files. */
  getLastTurnFileEdits(): CliSavedFileEdit[] {
    return [...this.previousTurnFileEdits]
  }

  /**
   * Revert only while Nexus's last written bytes are still authoritative.
   * Preflight every path before mutating any so a normal user edit cannot
   * produce a half-reverted turn.
   */
  async revertLastTurnFiles(): Promise<CliFileRevertResult> {
    if (this.pendingLastTurnFileRevert.length > 0) {
      return {
        reverted: this.pendingLastTurnFileRevert.map((edit) => edit.path),
        conflicts: [{
          path: this.pendingLastTurnFileRevert[0]!.path,
          reason: "the previous file undo is still awaiting conversation commit",
        }],
      }
    }
    const conflicts: CliFileRevertResult["conflicts"] = []
    for (const edit of this.previousTurnFileEdits) {
      try {
        const current = await fs.readFile(edit.path, "utf8")
        if (current !== edit.newContent) {
          conflicts.push({
            path: edit.path,
            reason: "file changed after the agent edit",
          })
        }
      } catch (error) {
        conflicts.push({
          path: edit.path,
          reason:
            error instanceof Error
              ? error.message
              : "file is no longer readable",
        })
      }
    }
    if (conflicts.length > 0) return { reverted: [], conflicts }

    const restored: CliSavedFileEdit[] = []
    for (const edit of [...this.previousTurnFileEdits].reverse()) {
      try {
        if (edit.isNewFile) await fs.unlink(edit.path)
        else await this.writeFile(edit.path, edit.originalContent)
        restored.push(edit)
      } catch (error) {
        conflicts.push({
          path: edit.path,
          reason: error instanceof Error ? error.message : "restore failed",
        })
        break
      }
    }
    if (conflicts.length > 0) {
      const stillReverted: string[] = []
      for (const edit of restored.reverse()) {
        try {
          if (edit.isNewFile) {
            const exists = await fs.access(edit.path)
              .then(() => true)
              .catch(() => false)
            if (exists) {
              throw new Error(
                "new file reappeared while rolling back a failed undo",
              )
            }
          } else {
            const current = await fs.readFile(edit.path, "utf8")
            if (current !== edit.originalContent) {
              throw new Error(
                "file changed while rolling back a failed undo",
              )
            }
          }
          await this.writeFile(edit.path, edit.newContent)
        } catch (error) {
          stillReverted.push(edit.path)
          conflicts.push({
            path: edit.path,
            reason:
              `failed to roll back partial undo: ` +
              (error instanceof Error ? error.message : "unknown failure"),
          })
        }
      }
      return { reverted: stillReverted, conflicts }
    }

    this.pendingLastTurnFileRevert = [...this.previousTurnFileEdits]
    return {
      reverted: restored.map((edit) => edit.path),
      conflicts: [],
    }
  }

  /** Commit the file half of a successful two-phase CLI undo. */
  commitLastTurnFileRevert(): void {
    if (this.pendingLastTurnFileRevert.length === 0) return
    this.pendingLastTurnFileRevert = []
    this.previousTurnFileEdits = []
  }

  /**
   * Put files back into the exact agent-written state when the conversation
   * rewind could not be persisted. Compare-and-swap checks prevent this
   * compensation from overwriting edits made during the failed save.
   */
  async rollbackLastTurnFileRevert(): Promise<CliFileRevertResult> {
    const edits = [...this.pendingLastTurnFileRevert]
    if (edits.length === 0) return { reverted: [], conflicts: [] }

    const conflicts: CliFileRevertResult["conflicts"] = []
    const stillReverted = new Set<string>()
    for (const edit of edits) {
      try {
        if (edit.isNewFile) {
          const exists = await fs.access(edit.path)
            .then(() => true)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false
              throw error
            })
          if (exists) {
            conflicts.push({
              path: edit.path,
              reason: "new file reappeared after the file undo",
            })
          } else {
            stillReverted.add(edit.path)
          }
        } else {
          const current = await fs.readFile(edit.path, "utf8")
          if (current !== edit.originalContent) {
            conflicts.push({
              path: edit.path,
              reason: "file changed after the file undo",
            })
          } else {
            stillReverted.add(edit.path)
          }
        }
      } catch (error) {
        conflicts.push({
          path: edit.path,
          reason:
            error instanceof Error
              ? error.message
              : "file is no longer readable",
        })
      }
    }
    if (conflicts.length > 0) {
      return {
        reverted: [...stillReverted],
        conflicts,
      }
    }

    const reapplied: CliSavedFileEdit[] = []
    for (const edit of edits) {
      try {
        await this.writeFile(edit.path, edit.newContent)
        reapplied.push(edit)
      } catch (error) {
        conflicts.push({
          path: edit.path,
          reason:
            "failed to restore the agent-written state: " +
            (error instanceof Error ? error.message : "unknown failure"),
        })
        break
      }
    }
    if (conflicts.length > 0) {
      const stillReverted = new Set(edits.map((edit) => edit.path))
      for (const edit of [...reapplied].reverse()) {
        try {
          const current = await fs.readFile(edit.path, "utf8")
          if (current !== edit.newContent) {
            throw new Error(
              "file changed while rolling back undo compensation",
            )
          }
          if (edit.isNewFile) await fs.unlink(edit.path)
          else await this.writeFile(edit.path, edit.originalContent)
        } catch (error) {
          stillReverted.delete(edit.path)
          conflicts.push({
            path: edit.path,
            reason:
              "failed to restore the compensated file undo: " +
              (error instanceof Error ? error.message : "unknown failure"),
          })
        }
      }
      return {
        reverted: [...stillReverted],
        conflicts,
      }
    }

    this.pendingLastTurnFileRevert = []
    return { reverted: [], conflicts: [] }
  }

  async revertFileEdit(filePath: string): Promise<void> {
    const key = filePath.replace(/\\/g, "/")
    this.pendingFileEdits.delete(key)
  }

  /** Resolve and authorize a path against this host's exact workspace root. */
  private resolve(filePath: string): string {
    return resolveAuthorizedWorkspacePath(this.cwd, filePath)
  }

  /** Guard against reading/writing sensitive paths */
  private checkPathSecurity(absPath: string, op: string): void {
    const ext = path.extname(absPath).toLowerCase()
    if (DENY_EXTENSIONS.has(ext)) {
      throw new Error(`Security: ${op} denied for ${absPath} (extension blocked)`)
    }
    const base = path.basename(absPath)
    for (const denied of DENY_PATHS) {
      if (base.toLowerCase().includes(denied.toLowerCase())) {
        // Only throw for write/delete
        if (op !== "read") {
          throw new Error(`Security: ${op} denied for ${absPath} (path pattern blocked)`)
        }
      }
    }
  }
}
