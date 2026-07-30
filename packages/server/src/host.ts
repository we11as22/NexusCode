import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { execa } from "execa"
import {
  createSandboxRequest,
  resolveSandboxBinary,
  runSandboxed,
  startSandboxed,
} from "@nexuscode/sandbox"
import {
  authorizeNetworkRequest as authorizePublicNetworkRequest,
  FileMutationConflictError,
  hashFileContent,
} from "@nexuscode/core"
import type {
  AgentEvent,
  ApprovalAction,
  AuthorizedNetworkRequest,
  HostNetworkRequest,
  HostPathAccess,
  HostReadFileOptions,
  IHost,
  McpAuthRequest,
  McpAuthResult,
  Mode,
  ModeChangeResult,
  PermissionResult,
  CapturedFileState,
  HostFileMutation,
  HostSandboxCommandRequest,
  HostSandboxCommandResult,
  HostSandboxProcess,
  HostSandboxStartOptions,
} from "@nexuscode/core"
import { resolveWorkspaceRoot } from "./security.js"

const DENY_EXTENSIONS = new Set([".env", ".key", ".pem", ".crt", ".p12", ".pfx"])
const DENY_PATHS = [".env", "secrets", ".ssh", "id_rsa", "id_ed25519"]
const MAX_CHANGE_FILE_BYTES = 128 * 1_024 * 1_024
const SERVER_PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
)
const SERVER_SANDBOX_ROOTS = [
  SERVER_PACKAGE_ROOT,
  path.resolve(SERVER_PACKAGE_ROOT, "..", "sandbox"),
]
const SERVER_PROTECTED_RUNTIME_ROOTS = [
  path.join(SERVER_PACKAGE_ROOT, "dist"),
  path.join(SERVER_PACKAGE_ROOT, "vendor"),
]

function createPrivateSandboxTempDirectory(): string {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), "nexus-sandbox-"))
}

async function removePrivateSandboxTempDirectory(
  directory: string,
): Promise<void> {
  await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined)
}

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

/**
 * Server host — runs on the server machine and emits events to the stream.
 * Privileged requests fail closed unless the authenticated run transport
 * provides an interactive approval callback.
 */
export class ServerHost implements IHost {
  readonly cwd: string
  readonly capabilities = { interactiveQuestions: true } as const
  private onEvent: (event: AgentEvent) => void
  private requestApproval?: (action: ApprovalAction) => Promise<PermissionResult>
  private persistModeChange?: (
    mode: Mode,
    reason?: string,
  ) => Promise<ModeChangeResult>

  constructor(
    cwd: string,
    onEvent: (event: AgentEvent) => void,
    options: {
      requestApproval?: (action: ApprovalAction) => Promise<PermissionResult>
      requestModeChange?: (
        mode: Mode,
        reason?: string,
      ) => Promise<ModeChangeResult>
    } = {},
  ) {
    this.cwd = cwd
    this.onEvent = onEvent
    this.requestApproval = options.requestApproval
    this.persistModeChange = options.requestModeChange
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

  private resolve(filePath: string): string {
    const requested = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.cwd, filePath)
    return resolveWorkspaceRoot(requested, [this.cwd])
  }

  private checkPathSecurity(absPath: string, op: string): void {
    if (
      op !== "read" &&
      SERVER_PROTECTED_RUNTIME_ROOTS.some((root) =>
        isSameOrDescendant(root, absPath),
      )
    ) {
      throw new Error(
        `Security: ${op} denied for immutable NexusCode runtime ${absPath}`,
      )
    }
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

  async runSandboxedCommand(
    request: HostSandboxCommandRequest,
    signal?: AbortSignal,
  ): Promise<HostSandboxCommandResult> {
    const commandCwd = resolveWorkspaceRoot(request.cwd || this.cwd, [this.cwd])
    const workspaceRoot = resolveWorkspaceRoot(this.cwd, [this.cwd])
    const binaryPath = resolveSandboxBinary({
      trustedRoots: SERVER_SANDBOX_ROOTS,
    })
    const tempDir = createPrivateSandboxTempDirectory()
    try {
      return await runSandboxed(
        createSandboxRequest({
          executionId: request.executionId,
          command: request.command,
          cwd: commandCwd,
          workspaceRoots: [workspaceRoot],
          protectedRoots: SERVER_PROTECTED_RUNTIME_ROOTS,
          profile: request.profile,
          network: request.network,
          timeoutMs: request.timeoutMs,
          tempDir,
        }),
        { binaryPath, signal },
      )
    } finally {
      await removePrivateSandboxTempDirectory(tempDir)
    }
  }

  startSandboxedCommand(
    request: HostSandboxCommandRequest,
    options: HostSandboxStartOptions = {},
  ): HostSandboxProcess {
    const commandCwd = resolveWorkspaceRoot(request.cwd || this.cwd, [this.cwd])
    const workspaceRoot = resolveWorkspaceRoot(this.cwd, [this.cwd])
    const binaryPath = resolveSandboxBinary({
      trustedRoots: SERVER_SANDBOX_ROOTS,
    })
    const tempDir = createPrivateSandboxTempDirectory()
    let handle
    try {
      handle = startSandboxed(
        createSandboxRequest({
          executionId: request.executionId,
          command: request.command,
          cwd: commandCwd,
          workspaceRoots: [workspaceRoot],
          protectedRoots: SERVER_PROTECTED_RUNTIME_ROOTS,
          profile: request.profile,
          network: request.network,
          timeoutMs: request.timeoutMs,
          tempDir,
        }),
        {
          binaryPath,
          detached: process.platform !== "win32",
          maxOutputBytes: options.maxOutputBytes,
          onStdout: options.onStdout,
          onStderr: options.onStderr,
        },
      )
    } catch (error) {
      void removePrivateSandboxTempDirectory(tempDir)
      throw error
    }
    const completion = handle.result.finally(() =>
      removePrivateSandboxTempDirectory(tempDir),
    )
    return {
      pid: handle.pid,
      ready: handle.ready,
      completion,
      stop: handle.stop,
    }
  }

  async showApprovalDialog(
    action: ApprovalAction,
    signal?: AbortSignal,
  ): Promise<PermissionResult> {
    if (signal?.aborted) return { approved: false }
    return this.requestApproval?.(action) ?? { approved: false }
  }

  async requestModeChange(
    mode: Mode,
    reason?: string,
  ): Promise<ModeChangeResult> {
    if (!this.persistModeChange) {
      return {
        success: false,
        mode,
        message:
          "The server runtime cannot persist a mode transition for this turn.",
      }
    }
    return this.persistModeChange(mode, reason)
  }

  emit(event: AgentEvent): void {
    this.onEvent(event)
  }

  async requestMcpAuthentication(request: McpAuthRequest): Promise<McpAuthResult> {
    return {
      success: false,
      ...(request.startUrl ? { pending: true } : {}),
      message: request.message?.trim() || (request.startUrl
        ? `Authenticate MCP server "${request.server}" at ${request.startUrl}`
        : `MCP server "${request.server}" requires manual authentication.`),
    }
  }
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}
