import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execa } from "execa"
import type { IHost, AgentEvent, ApprovalAction, PermissionResult, McpAuthRequest, McpAuthResult } from "@nexuscode/core"
import { resolveWorkspaceRoot } from "./security.js"

const DENY_EXTENSIONS = new Set([".env", ".key", ".pem", ".crt", ".p12", ".pfx"])
const DENY_PATHS = [".env", "secrets", ".ssh", "id_rsa", "id_ed25519"]

/**
 * Server host — runs on the server machine and emits events to the stream.
 * Privileged requests fail closed unless the authenticated run transport
 * provides an interactive approval callback.
 */
export class ServerHost implements IHost {
  readonly cwd: string
  private onEvent: (event: AgentEvent) => void
  private requestApproval?: (action: ApprovalAction) => Promise<PermissionResult>

  constructor(
    cwd: string,
    onEvent: (event: AgentEvent) => void,
    options: {
      requestApproval?: (action: ApprovalAction) => Promise<PermissionResult>
    } = {},
  ) {
    this.cwd = cwd
    this.onEvent = onEvent
    this.requestApproval = options.requestApproval
  }

  private resolve(filePath: string): string {
    const requested = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.cwd, filePath)
    return resolveWorkspaceRoot(requested, [this.cwd])
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
    const commandCwd = resolveWorkspaceRoot(cwd || this.cwd, [this.cwd])
    const result = await execa(command, {
      shell: true,
      cwd: commandCwd,
      reject: false,
      cancelSignal: signal,
    })
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
    }
  }

  async showApprovalDialog(action: ApprovalAction): Promise<PermissionResult> {
    return this.requestApproval?.(action) ?? { approved: false }
  }

  emit(event: AgentEvent): void {
    this.onEvent(event)
  }

  async requestMcpAuthentication(request: McpAuthRequest): Promise<McpAuthResult> {
    return {
      success: Boolean(request.startUrl),
      message: request.message?.trim() || (request.startUrl
        ? `Authenticate MCP server "${request.server}" at ${request.startUrl}`
        : `MCP server "${request.server}" requires manual authentication.`),
    }
  }
}
