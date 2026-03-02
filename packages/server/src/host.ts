import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execa } from "execa"
import type { IHost, AgentEvent, ApprovalAction, PermissionResult } from "@nexuscode/core"

const DENY_EXTENSIONS = new Set([".env", ".key", ".pem", ".crt", ".p12", ".pfx"])
const DENY_PATHS = [".env", "secrets", ".ssh", "id_rsa", "id_ed25519"]

/**
 * Server host — runs on server machine, emits events to stream. Auto-approves all actions (like "Allow Always").
 */
export class ServerHost implements IHost {
  readonly cwd: string
  private onEvent: (event: AgentEvent) => void

  constructor(cwd: string, onEvent: (event: AgentEvent) => void) {
    this.cwd = cwd
    this.onEvent = onEvent
  }

  private resolve(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath
    return path.resolve(this.cwd, filePath)
  }

  private checkPathSecurity(absPath: string, op: string): void {
    const ext = path.extname(absPath).toLowerCase()
    if (DENY_EXTENSIONS.has(ext)) {
      throw new Error(`Security: ${op} denied for ${absPath} (extension blocked)`)
    }
    const base = path.basename(absPath)
    for (const denied of DENY_PATHS) {
      if (base.toLowerCase().includes(denied.toLowerCase()) && op !== "read") {
        throw new Error(`Security: ${op} denied for ${absPath} (path pattern blocked)`)
      }
    }
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
    return fs.access(this.resolve(filePath)).then(() => true).catch(() => false)
  }

  async showDiff(_path: string, _before: string, _after: string): Promise<boolean> {
    return true
  }

  async runCommand(command: string, cwd: string, signal?: AbortSignal) {
    const result = await execa(command, {
      shell: true,
      cwd: cwd || this.cwd,
      reject: false,
      timeout: 120_000,
      signal,
    })
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    }
  }

  async showApprovalDialog(_action: ApprovalAction): Promise<PermissionResult> {
    return { approved: true }
  }

  emit(event: AgentEvent): void {
    this.onEvent(event)
  }
}
