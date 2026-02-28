import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as readline from "node:readline"
import { execa } from "execa"
import type { IHost, AgentEvent, ApprovalAction, PermissionResult, DiagnosticItem } from "@nexuscode/core"

const DENY_EXTENSIONS = new Set([".env", ".key", ".pem", ".crt", ".p12", ".pfx"])
const DENY_PATHS = [".env", "secrets", ".ssh", "id_rsa", "id_ed25519"]

/**
 * CLI host adapter — terminal-based approvals, output, and security guards.
 */
export class CliHost implements IHost {
  readonly cwd: string
  private eventEmitter: (event: AgentEvent) => void
  private autoApprove: boolean
  /** Remember "always approve" decisions per tool type for this session */
  private alwaysApproved = new Set<string>()

  constructor(cwd: string, onEvent: (event: AgentEvent) => void, autoApprove = false) {
    this.cwd = cwd
    this.eventEmitter = onEvent
    this.autoApprove = autoApprove
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

    return new Promise(resolve => {
      const lines: string[] = [""]

      if (action.type === "execute") {
        lines.push(`\x1b[1;33m⚡ Command execution requested:\x1b[0m`)
        lines.push(`  \x1b[36m${action.description}\x1b[0m`)
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

      lines.push(`\x1b[90m[y] Yes  [n] No  [a] Always  [s] Skip all\x1b[0m`)
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
        const approved = ["y", "yes", "a", "always", "s", "skip"].includes(lower)
        const alwaysApprove = lower === "a" || lower === "always"
        const skipAll = lower === "s" || lower === "skip"

        if (alwaysApprove) {
          this.alwaysApproved.add(alwaysKey)
        }
        if (skipAll) {
          this.autoApprove = true
        }

        resolve({ approved, alwaysApprove })
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
