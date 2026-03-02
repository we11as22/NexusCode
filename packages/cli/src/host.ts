import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as readline from "node:readline"
import { execa } from "execa"
import type { IHost, AgentEvent, ApprovalAction, PermissionResult, DiagnosticItem } from "@nexuscode/core"

const DENY_EXTENSIONS = new Set([".env", ".key", ".pem", ".crt", ".p12", ".pfx"])
const DENY_PATHS = [".env", "secrets", ".ssh", "id_rsa", "id_ed25519"]

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
  /** Remember "always approve" decisions per tool type for this session */
  private alwaysApproved = new Set<string>()

  constructor(
    cwd: string,
    onEvent: (event: AgentEvent) => void,
    autoApprove = false,
    tuiApprovalRef?: { current: ((r: PermissionResult) => void) | null }
  ) {
    this.cwd = cwd
    this.eventEmitter = onEvent
    this.autoApprove = autoApprove
    this.tuiApprovalRef = tuiApprovalRef
  }

  async readFile(filePath: string): Promise<string> {
    const absPath = this.resolve(filePath)
    this.checkPathSecurity(absPath, "read")
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
    const result = await execa(command, {
      shell: true,
      cwd: cwd || this.cwd,
      reject: false,
      timeout: 120_000,
    })
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    }
  }

  async showApprovalDialog(action: ApprovalAction): Promise<PermissionResult> {
    if (this.autoApprove) return { approved: true }

    // Read ops always auto-approved in CLI
    if (action.type === "read") return { approved: true }

    // Check "always approve" memory for this session
    const alwaysKey = `${action.type}:${action.tool}`
    if (this.alwaysApproved.has(alwaysKey)) return { approved: true }

    // TUI mode: don't use readline — return Promise resolved by TUI when user types y/n/a/s
    if (this.tuiApprovalRef) {
      return new Promise<PermissionResult>(resolve => {
        this.tuiApprovalRef!.current = (result: PermissionResult) => {
          this.tuiApprovalRef!.current = null
          if (result.alwaysApprove) this.alwaysApproved.add(alwaysKey)
          if (result.skipAll) this.autoApprove = true
          resolve(result)
        }
      })
    }

    // Non-TUI: use readline (e.g. --print or headless)
    return new Promise(resolve => {
      const lines: string[] = [""]

      if (action.type === "execute") {
        lines.push(`\x1b[1;33m⌨️  Bash\x1b[0m`)
        const cmd = action.content || action.description.replace(/^Run:\s*/i, "")
        lines.push(`  \x1b[36m${cmd}\x1b[0m`)
      } else if (action.type === "write") {
        lines.push(`\x1b[1;32m✏ File write requested:\x1b[0m`)
        lines.push(`  \x1b[36m${action.description}\x1b[0m`)
        if (action.content) {
          const preview = action.content.split("\n").slice(0, 5).join("\n")
          lines.push(`  \x1b[90m${preview}\x1b[0m`)
        }
      } else if (action.type === "mcp") {
        lines.push(`\x1b[1;35m🔌 MCP tool call:\x1b[0m`)
        lines.push(`  \x1b[36m${action.description}\x1b[0m`)
      } else if (action.type === "doom_loop") {
        lines.push(`\x1b[1;31m⚠ Potential infinite loop detected:\x1b[0m`)
        lines.push(`  \x1b[31m${action.description}\x1b[0m`)
      }

      const optionsLine =
        action.type === "execute"
          ? `\x1b[90m[y]es [n]o [a]lways [s]kip [e] allow for folder\x1b[0m`
          : `\x1b[90m[y]es [n]o [a]lways [s]kip all\x1b[0m`
      lines.push(optionsLine)
      lines.push("")
      process.stdout.write(lines.join("\n"))
      process.stdout.write(`\x1b[1mAllow? \x1b[0m`)

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: process.stdout.isTTY,
      })

      rl.once("line", (answer: string) => {
        rl.close()
        const lower = answer.trim().toLowerCase()
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

        resolve({
          approved,
          alwaysApprove,
          skipAll,
          addToAllowedCommand: addToAllowed && action.content ? action.content : undefined,
        })
      })

      // Non-TTY (CI/pipe) — default approve with warning
      if (!process.stdin.isTTY) {
        rl.close()
        process.stderr.write("[nexus] Non-interactive mode: auto-approving all actions\n")
        resolve({ approved: true })
      }
    })
  }

  emit(event: AgentEvent): void {
    this.eventEmitter(event)
  }

  async addAllowedCommand(cwd: string, command: string): Promise<void> {
    const dir = path.join(cwd, ".nexus")
    const filePath = path.join(dir, "allowed-commands.json")
    const normalized = command.trim().replace(/\s+/g, " ")
    if (!normalized) return
    let commands: string[] = []
    try {
      const raw = await fs.readFile(filePath, "utf8")
      const parsed = JSON.parse(raw) as { commands?: string[] }
      if (Array.isArray(parsed?.commands)) commands = [...parsed.commands]
    } catch {
      // File missing or invalid — start fresh
    }
    if (commands.includes(normalized)) return
    commands.push(normalized)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, JSON.stringify({ commands }, null, 2), "utf8")
  }

  async getProblems(): Promise<DiagnosticItem[]> {
    return []
  }

  /** Resolve path relative to cwd if not absolute */
  private resolve(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath
    return path.resolve(this.cwd, filePath)
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
