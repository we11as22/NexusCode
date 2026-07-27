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
  private turnFileEdits: Array<{ path: string; originalContent: string; isNewFile: boolean }> = []
  /** Previous turn's edits; used by revertLastTurn to restore files. */
  private previousTurnFileEdits: Array<{ path: string; originalContent: string; isNewFile: boolean }> = []

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
    this.turnFileEdits.push({ path: filePath, originalContent: pending.originalContent, isNewFile: pending.isNewFile })
    this.pendingFileEdits.delete(key)
    await this.writeFile(filePath, pending.newContent)
  }

  /** Call when a new assistant turn starts (e.g. on assistant_message_started). Moves current turn edits to previous. */
  startNewTurn(): void {
    this.previousTurnFileEdits = [...this.turnFileEdits]
    this.turnFileEdits = []
  }

  /** Edits from the last completed assistant turn; used by revertLastTurn to restore files. */
  getLastTurnFileEdits(): Array<{ path: string; originalContent: string; isNewFile: boolean }> {
    return [...this.previousTurnFileEdits]
  }

  /** Revert files from the last turn (write back originalContent, delete if was new file). Call after rewinding session. */
  async revertLastTurnFiles(): Promise<void> {
    for (const e of this.previousTurnFileEdits) {
      const absPath = this.resolve(e.path)
      try {
        if (e.isNewFile) {
          await fs.unlink(absPath)
        } else {
          await fs.writeFile(absPath, e.originalContent, "utf8")
        }
      } catch {
        // Ignore per-file errors
      }
    }
    this.previousTurnFileEdits = []
    this.turnFileEdits = []
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
