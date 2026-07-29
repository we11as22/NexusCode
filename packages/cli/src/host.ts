import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as readline from "node:readline"
import { randomUUID } from "node:crypto"
import { execa } from "execa"
import {
  authorizeNetworkRequest as authorizePublicNetworkRequest,
  approvalGrantKey,
  grantWorkspaceAuthority,
  resolveAuthorizedWorkspacePath,
  hashFileContent,
  FileMutationConflictError,
  ChangeSetService,
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
  CapturedFileState,
  HostFileMutation,
  HostCapabilities,
} from "@nexuscode/core"
import { getRipgrepCommand } from "./utils/ripgrep.js"

const DENY_EXTENSIONS = new Set([".env", ".key", ".pem", ".crt", ".p12", ".pfx"])
const DENY_PATHS = [".env", "secrets", ".ssh", "id_rsa", "id_ed25519"]
const MAX_CHANGE_FILE_BYTES = 128 * 1_024 * 1_024

function absentFileState(): CapturedFileState {
  return { exists: false, content: null, mode: null }
}

function capturedMatchesExpected(
  captured: CapturedFileState,
  expected: HostFileMutation["expected"],
): boolean {
  if (captured.exists !== expected.exists) return false
  if (!captured.exists || !expected.exists) return true
  const digest = hashFileContent(captured.content)
  return (
    digest.hash === expected.hash &&
    digest.byteLength === expected.byteLength &&
    captured.mode === expected.mode
  )
}

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
  readonly capabilities: HostCapabilities
  private eventEmitter: (event: AgentEvent) => void
  private autoApprove: boolean
  /** When set, approval is resolved via this ref (TUI mode — no readline). */
  private tuiApprovalRef?: { current: ((r: PermissionResult) => void) | null }
  private alwaysApproved = new Set<string>()
  private nonInteractiveDiagnosticEmitted = false
  private durableReview?: {
    service: ChangeSetService
    sessionId: string
    turnId: string
  }
  private pendingLastTurnChangeSetIds: string[] = []

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
    this.capabilities = {
      interactiveQuestions: tuiApprovalRef !== undefined,
    }
  }

  async resolvePath(
    filePath: string,
    access: HostPathAccess,
  ): Promise<string> {
    const absPath = this.resolve(filePath)
    this.checkPathSecurity(absPath, access === "list" ? "read" : access)
    return absPath
  }

  async resolveRipgrepCommand() {
    return getRipgrepCommand()
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

  async readFileState(filePath: string): Promise<CapturedFileState> {
    const absPath = this.resolve(filePath)
    this.checkPathSecurity(absPath, "read")
    let info
    try {
      info = await fs.lstat(absPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return absentFileState()
      }
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(
        `Durable file changes require a regular non-symbolic file: ${filePath}`,
      )
    }
    if (info.size > MAX_CHANGE_FILE_BYTES) {
      throw new Error(
        `File exceeds the ${MAX_CHANGE_FILE_BYTES}-byte durable change limit`,
      )
    }
    const content = await fs.readFile(absPath)
    if (content.byteLength > MAX_CHANGE_FILE_BYTES) {
      throw new Error(
        `File exceeds the ${MAX_CHANGE_FILE_BYTES}-byte durable change limit`,
      )
    }
    return {
      exists: true,
      content,
      mode: info.mode & 0o7777,
    }
  }

  async applyFileMutation(mutation: HostFileMutation): Promise<void> {
    const absPath = this.resolve(mutation.path)
    this.checkPathSecurity(absPath, "write")
    const current = await this.readFileState(mutation.path)
    if (!capturedMatchesExpected(current, mutation.expected)) {
      throw new FileMutationConflictError(mutation.path)
    }
    if (!mutation.next.exists) {
      await fs.unlink(absPath)
      return
    }
    const bytes = Buffer.from(mutation.next.content)
    if (bytes.byteLength > MAX_CHANGE_FILE_BYTES) {
      throw new Error(
        `File exceeds the ${MAX_CHANGE_FILE_BYTES}-byte durable change limit`,
      )
    }
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    const temporary = path.join(
      path.dirname(absPath),
      `.${path.basename(absPath)}.${process.pid}.${randomUUID()}.nexus-tmp`,
    )
    const mode = mutation.next.mode ?? 0o644
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      handle = await fs.open(temporary, "wx", mode)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.chmod(mode)
      await handle.close()
      handle = undefined
      const rechecked = await this.readFileState(mutation.path)
      if (!capturedMatchesExpected(rechecked, mutation.expected)) {
        throw new FileMutationConflictError(mutation.path)
      }
      await fs.rename(temporary, absPath)
    } finally {
      await handle?.close().catch(() => undefined)
      await fs.unlink(temporary).catch(() => undefined)
    }
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

  bindDurableChangeReview(
    service: ChangeSetService,
    sessionId: string,
    turnId: string,
  ): void {
    this.durableReview = { service, sessionId, turnId }
  }

  /**
   * Revert only while Nexus's last written bytes are still authoritative.
   * Preflight every path before mutating any so a normal user edit cannot
   * produce a half-reverted turn.
   */
  async revertLastTurnFiles(): Promise<CliFileRevertResult> {
    if (!this.durableReview) {
      return {
        reverted: [],
        conflicts: [{
          path: "(change service)",
          reason:
            "durable change ownership is unavailable; no files were changed",
        }],
      }
    }
    return this.revertLastTurnChangeSets()
  }

  /** Commit the file half of a successful two-phase CLI undo. */
  commitLastTurnFileRevert(): void {
    this.pendingLastTurnChangeSetIds = []
  }

  /**
   * Put files back into the exact agent-written state when the conversation
   * rewind could not be persisted. Compare-and-swap checks prevent this
   * compensation from overwriting edits made during the failed save.
   */
  async rollbackLastTurnFileRevert(): Promise<CliFileRevertResult> {
    if (
      this.durableReview &&
      this.pendingLastTurnChangeSetIds.length > 0
    ) {
      return this.rollbackLastTurnChangeSets()
    }
    return { reverted: [], conflicts: [] }
  }

  private async revertLastTurnChangeSets(): Promise<CliFileRevertResult> {
    const review = this.durableReview!
    if (this.pendingLastTurnChangeSetIds.length > 0) {
      return {
        reverted: [],
        conflicts: [{
          path: this.pendingLastTurnChangeSetIds[0]!,
          reason:
            "the previous durable file undo is still awaiting conversation commit",
        }],
      }
    }
    const recovered = await review.service.recoverInterrupted({
      sessionId: review.sessionId,
      turnId: review.turnId,
    })
    const ambiguous = recovered.find(
      (record) => record.state === "conflicted",
    )
    if (ambiguous) {
      return {
        reverted: [],
        conflicts: [{
          path: ambiguous.files.map((file) => file.path).join(", "),
          reason:
            `durable change ${ambiguous.id} has an ambiguous interrupted transition`,
        }],
      }
    }
    const records = await review.service.listEffectiveApplied({
      sessionId: review.sessionId,
      turnId: review.turnId,
    })
    if (records.length === 0) {
      return { reverted: [], conflicts: [] }
    }
    const reverted: Array<(typeof records)[number]> = []
    for (const record of [...records].reverse()) {
      try {
        const result = await review.service.revert(record.id)
        if (result.state !== "reverted") {
          throw new Error(
            `change set ${record.id} recovered to ${result.state}`,
          )
        }
        reverted.push(result)
      } catch (error) {
        const conflicts: CliFileRevertResult["conflicts"] = [{
          path: record.files.map((file) => file.path).join(", "),
          reason:
            error instanceof Error ? error.message : String(error),
        }]
        const stillReverted = new Set(reverted.map((item) => item.id))
        for (const restored of [...reverted].reverse()) {
          try {
            const reapplied = await review.service.reapply(restored.id)
            if (reapplied.state !== "applied") {
              throw new Error(
                `change set ${restored.id} recovered to ${reapplied.state}`,
              )
            }
            stillReverted.delete(restored.id)
          } catch (compensationError) {
            conflicts.push({
              path: restored.files.map((file) => file.path).join(", "),
              reason:
                "failed to compensate partial durable undo: " +
                (compensationError instanceof Error
                  ? compensationError.message
                  : String(compensationError)),
            })
          }
        }
        return {
          reverted: reverted
            .filter((item) => stillReverted.has(item.id))
            .flatMap((item) => item.files.map((file) => file.path)),
          conflicts,
        }
      }
    }
    this.pendingLastTurnChangeSetIds = reverted.map((record) => record.id)
    return {
      reverted: reverted.flatMap((record) =>
        record.files.map((file) => file.path),
      ),
      conflicts: [],
    }
  }

  private async rollbackLastTurnChangeSets(): Promise<CliFileRevertResult> {
    const review = this.durableReview!
    const ids = [...this.pendingLastTurnChangeSetIds]
    const conflicts: CliFileRevertResult["conflicts"] = []
    const stillReverted = new Set(ids)
    for (const id of [...ids].reverse()) {
      try {
        const reapplied = await review.service.reapply(id)
        if (reapplied.state !== "applied") {
          throw new Error(
            `change set ${id} recovered to ${reapplied.state}`,
          )
        }
        stillReverted.delete(id)
      } catch (error) {
        conflicts.push({
          path: id,
          reason:
            "failed to restore the agent-written durable change: " +
            (error instanceof Error ? error.message : String(error)),
        })
      }
    }
    if (conflicts.length === 0) {
      this.pendingLastTurnChangeSetIds = []
    }
    return {
      reverted: [...stillReverted],
      conflicts,
    }
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
