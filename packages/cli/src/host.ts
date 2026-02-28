import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as readline from "node:readline"
import { execa } from "execa"
import type { IHost, AgentEvent, ApprovalAction, PermissionResult, DiagnosticItem } from "@nexuscode/core"

/**
 * CLI host adapter — terminal-based approvals and output.
 * Uses readline for interactive prompts.
 */
export class CliHost implements IHost {
  readonly cwd: string
  private eventEmitter: (event: AgentEvent) => void
  private autoApprove: boolean

  constructor(cwd: string, onEvent: (event: AgentEvent) => void, autoApprove = false) {
    this.cwd = cwd
    this.eventEmitter = onEvent
    this.autoApprove = autoApprove
  }

  async readFile(filePath: string): Promise<string> {
    const absPath = filePath.startsWith("/") ? filePath : path.join(this.cwd, filePath)
    return fs.readFile(absPath, "utf8")
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const absPath = filePath.startsWith("/") ? filePath : path.join(this.cwd, filePath)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    await fs.writeFile(absPath, content, "utf8")
  }

  async deleteFile(filePath: string): Promise<void> {
    const absPath = filePath.startsWith("/") ? filePath : path.join(this.cwd, filePath)
    await fs.unlink(absPath)
  }

  async exists(filePath: string): Promise<boolean> {
    const absPath = filePath.startsWith("/") ? filePath : path.join(this.cwd, filePath)
    return fs.access(absPath).then(() => true).catch(() => false)
  }

  async showDiff(_filePath: string, _before: string, _after: string): Promise<boolean> {
    return true // CLI just shows the diff inline via tool output
  }

  async runCommand(command: string, cwd: string, signal?: AbortSignal) {
    const result = await execa(command, {
      shell: true,
      cwd,
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
    if (action.type === "read") return { approved: true }

    return new Promise(resolve => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      })

      const prompt = action.type === "execute"
        ? `\n[nexus] Execute command: ${action.description}\nAllow? [y/N/a(always)] `
        : `\n[nexus] ${action.type} file: ${action.description}\nAllow? [y/N/a(always)] `

      process.stdout.write(prompt)

      rl.once("line", (answer) => {
        rl.close()
        const lower = answer.trim().toLowerCase()
        resolve({
          approved: lower === "y" || lower === "yes" || lower === "a" || lower === "always",
          alwaysApprove: lower === "a" || lower === "always",
        })
      })
    })
  }

  emit(event: AgentEvent): void {
    this.eventEmitter(event)
  }

  async getProblems(): Promise<DiagnosticItem[]> {
    return []
  }
}
