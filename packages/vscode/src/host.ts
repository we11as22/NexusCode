import * as vscode from "vscode"
import * as path from "path"
import {
  approvalGrantKey,
  authorizeNetworkRequest as authorizePublicNetworkRequest,
  grantWorkspaceAuthority,
  resolveAuthorizedWorkspacePath,
} from "@nexuscode/core"
import type {
  IHost,
  AgentEvent,
  ApprovalAction,
  PermissionResult,
  DiagnosticItem,
  CheckpointEntry,
  ChangedFile,
  LspCallRecord,
  LspLocation,
  LspQueryRequest,
  LspQueryResult,
  LspRange,
  LspSymbolRecord,
  Mode,
  McpAuthRequest,
  McpAuthResult,
  ModeChangeResult,
  WorkingDirectoryChangeResult,
  HostReadFileOptions,
  HostPathAccess,
  HostNetworkRequest,
  AuthorizedNetworkRequest,
  WorkspaceAuthorityStoreOptions,
} from "@nexuscode/core"
import { parseStrictExternalHttpUrl } from "./external-url-policy.js"

const NEXUS_PREVIEW_SCHEME = "nexuscode-preview"
const previewDocuments = new Map<string, string>()
let previewProviderRegistration: vscode.Disposable | undefined

export interface WebviewApprovalResolverSlot {
  current: {
    partId: string
    action: ApprovalAction
    resolve(result: PermissionResult): void
  } | null
}

function normalizeApprovalCommand(command: string): string {
  return command.trim().replace(/\s+/gu, " ")
}

export function resolveWebviewApproval(
  slot: WebviewApprovalResolverSlot,
  partId: string,
  result: PermissionResult,
): boolean {
  const pending = slot.current
  if (!pending || pending.partId !== partId) return false
  let exactResult = result
  if (result.addToAllowedCommand !== undefined) {
    const expected =
      pending.action.type === "execute"
        ? pending.action.content
        : undefined
    if (
      !expected?.trim() ||
      normalizeApprovalCommand(result.addToAllowedCommand) !==
        normalizeApprovalCommand(expected)
    ) {
      return false
    }
    exactResult = {
      ...result,
      addToAllowedCommand: expected,
    }
  }
  pending.resolve(exactResult)
  return true
}

function ensurePreviewProviderRegistered(): void {
  if (previewProviderRegistration) return
  previewProviderRegistration = vscode.workspace.registerTextDocumentContentProvider(NEXUS_PREVIEW_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return previewDocuments.get(uri.toString()) ?? ""
    },
  })
}

async function openReadonlyPreviewDocument(content: string, filePath: string, label: string): Promise<vscode.TextDocument> {
  ensurePreviewProviderRegistered()
  const lang = getLanguageFromExtension(path.extname(filePath))
  const fileName = path.basename(filePath) || "preview"
  const uri = vscode.Uri.parse(
    `${NEXUS_PREVIEW_SCHEME}:/${encodeURIComponent(fileName)}?label=${encodeURIComponent(label)}&id=${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  previewDocuments.set(uri.toString(), content)
  const doc = await vscode.workspace.openTextDocument(uri)
  try {
    if (lang && doc.languageId !== lang) {
      await vscode.languages.setTextDocumentLanguage(doc, lang)
    }
  } catch {
    // keep default/plaintext
  }
  return doc
}

/**
 * VS Code host adapter — bridges the core agent with VS Code APIs.
 * When useWebviewApproval is true, showApprovalDialog defers to webview (no native dialog).
 */
export class VsCodeHost implements IHost {
  private eventEmitter: (event: AgentEvent) => void
  readonly cwd: string
  private alwaysApproved = new Set<string>()
  private sessionAutoApprove = false
  private checkpointTracker?: { commit(description?: string): Promise<string>; getEntries(): CheckpointEntry[]; resetHead(hash: string): Promise<void>; getDiff(from: string, to?: string): Promise<ChangedFile[]> }
  private useWebviewApproval: boolean
  private runCommandsInTerminal: boolean
  private approvalResolveRef: WebviewApprovalResolverSlot | null = null
  private emittedApprovalPartId: string | null = null
  private onCheckpointEntriesUpdated?: () => void
  /** Called after an approved edit is written to disk; used to add to session unaccepted list. */
  private onSessionEditSaved?: (path: string, originalContent: string, newContent: string, isNewFile: boolean) => void
  private authorityStoreOptions: WorkspaceAuthorityStoreOptions

  private pendingFileEdits = new Map<string, { originalContent: string; newContent: string; isNewFile: boolean }>()

  private normalizePendingEditKey(filePath: string): string {
    const absPath = this.resolveWorkspacePath(filePath)
    return path.normalize(absPath).replace(/\\/g, "/")
  }

  constructor(
    cwd: string,
    onEvent: (event: AgentEvent) => void,
    options?: {
      useWebviewApproval?: boolean
      runCommandsInTerminal?: boolean
      approvalResolveRef?: WebviewApprovalResolverSlot
      onCheckpointEntriesUpdated?: () => void
      onSessionEditSaved?: (path: string, originalContent: string, newContent: string, isNewFile: boolean) => void
      onModeChangeRequested?: (mode: Mode, reason?: string) => Promise<void> | void
      onWorkingDirectoryChangeRequested?: (cwd: string, reason?: string) => Promise<void> | void
      authorityStoreOptions?: WorkspaceAuthorityStoreOptions
    }
  ) {
    this.cwd = cwd
    this.eventEmitter = onEvent
    this.useWebviewApproval = options?.useWebviewApproval ?? false
    this.runCommandsInTerminal = options?.runCommandsInTerminal ?? false
    this.approvalResolveRef = options?.approvalResolveRef ?? null
    this.onCheckpointEntriesUpdated = options?.onCheckpointEntriesUpdated
    this.onSessionEditSaved = options?.onSessionEditSaved
    this.onModeChangeRequested = options?.onModeChangeRequested
    this.onWorkingDirectoryChangeRequested = options?.onWorkingDirectoryChangeRequested
    this.authorityStoreOptions = options?.authorityStoreOptions ?? {}
  }

  private onModeChangeRequested?: (mode: Mode, reason?: string) => Promise<void> | void
  private onWorkingDirectoryChangeRequested?: (cwd: string, reason?: string) => Promise<void> | void

  setCheckpoint(tracker: { commit(description?: string): Promise<string>; getEntries(): CheckpointEntry[]; resetHead(hash: string): Promise<void>; getDiff(from: string, to?: string): Promise<ChangedFile[]> } | undefined): void {
    this.checkpointTracker = tracker
  }

  async restoreCheckpoint(hash: string): Promise<void> {
    if (!this.checkpointTracker?.resetHead) return
    const t = this.checkpointTracker as { resetHead(hash: string): Promise<void> }
    await t.resetHead(hash)
  }

  async getCheckpointEntries(): Promise<CheckpointEntry[]> {
    return this.checkpointTracker?.getEntries() ?? []
  }

  async getCheckpointDiff(fromHash: string, toHash?: string): Promise<ChangedFile[]> {
    if (!this.checkpointTracker?.getDiff) return []
    return (this.checkpointTracker as { getDiff(from: string, to?: string): Promise<ChangedFile[]> }).getDiff(fromHash, toHash)
  }

  notifyCheckpointEntriesUpdated(): void {
    this.onCheckpointEntriesUpdated?.()
  }

  private resolveWorkspacePath(filePath: string): string {
    return resolveAuthorizedWorkspacePath(this.cwd, filePath)
  }

  private isAuthorizedWorkspacePath(filePath: string): boolean {
    try {
      this.resolveWorkspacePath(filePath)
      return true
    } catch {
      return false
    }
  }

  private findOpenTextDocument(
    absolutePath: string,
  ): vscode.TextDocument | undefined {
    const normalizedPath = path.normalize(absolutePath)
    return vscode.workspace.textDocuments.find((document) => {
      if (document.uri.scheme !== "file") return false
      try {
        return (
          path.normalize(
            this.resolveWorkspacePath(document.uri.fsPath),
          ) === normalizedPath
        )
      } catch {
        return false
      }
    })
  }

  private async replaceOpenTextDocument(
    document: vscode.TextDocument,
    content: string,
  ): Promise<void> {
    const before = document.getText()
    const edit = new vscode.WorkspaceEdit()
    edit.replace(
      document.uri,
      new vscode.Range(
        document.positionAt(0),
        document.positionAt(before.length),
      ),
      content,
    )
    const applied = await vscode.workspace.applyEdit(edit)
    if (!applied) {
      throw new Error(
        `VS Code refused to apply the edit for ${document.uri.fsPath}`,
      )
    }
    if (document.getText() !== content) {
      throw new Error(
        `The editor buffer changed while applying the edit for ${document.uri.fsPath}; the buffer was left unsaved for manual review`,
      )
    }
    const saved = await document.save()
    if (!saved || document.isDirty || document.getText() !== content) {
      throw new Error(
        `VS Code could not safely save ${document.uri.fsPath}; the buffer was left open for manual review`,
      )
    }
  }

  private async ensureParentDirectories(absolutePath: string): Promise<void> {
    const dir = path.dirname(absolutePath)
    const cwdResolved = this.resolveWorkspacePath(".")
    const relDir = path.relative(cwdResolved, dir)
    if (!relDir || relDir === ".") return
    const parts = relDir.split(path.sep)
    let acc = cwdResolved
    for (const part of parts) {
      if (!part) continue
      acc = path.join(acc, part)
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(acc))
      } catch {
        // The directory may already exist.
      }
    }
  }

  private async writeAuthorizedFile(
    absolutePath: string,
    content: string,
    expectation?: {
      originalContent: string
      isNewFile: boolean
    },
  ): Promise<void> {
    const uri = vscode.Uri.file(absolutePath)
    const document = this.findOpenTextDocument(absolutePath)

    if (document) {
      if (expectation?.isNewFile) {
        throw new Error(
          `File edit conflict: ${absolutePath} was created after the edit was prepared`,
        )
      }
      if (
        expectation &&
        document.getText() !== expectation.originalContent
      ) {
        throw new Error(
          `File edit conflict: ${absolutePath} changed in the editor after the diff was prepared`,
        )
      }
      if (!expectation && document.isDirty) {
        throw new Error(
          `Refusing to overwrite unsaved editor changes in ${absolutePath}; save the file and retry`,
        )
      }
      await this.replaceOpenTextDocument(document, content)
      return
    }

    const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(
      () => undefined,
    )
    if (expectation?.isNewFile) {
      if (stat) {
        throw new Error(
          `File edit conflict: ${absolutePath} was created after the edit was prepared`,
        )
      }
    } else if (expectation) {
      if (!stat || (stat.type & vscode.FileType.Directory) !== 0) {
        throw new Error(
          `File edit conflict: ${absolutePath} no longer matches the prepared diff`,
        )
      }
      const current = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8")
      if (current !== expectation.originalContent) {
        throw new Error(
          `File edit conflict: ${absolutePath} changed on disk after the diff was prepared`,
        )
      }
    } else if (stat && (stat.type & vscode.FileType.Directory) !== 0) {
      throw new Error(`Path is a directory: ${absolutePath}`)
    }

    await this.ensureParentDirectories(absolutePath)
    await vscode.workspace.fs.writeFile(
      uri,
      new TextEncoder().encode(content),
    )
  }

  async resolvePath(
    filePath: string,
    _access: HostPathAccess,
  ): Promise<string> {
    return this.resolveWorkspacePath(filePath)
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
    const absPath = this.resolveWorkspacePath(filePath)
    const openDocument = this.findOpenTextDocument(absPath)
    if (openDocument) {
      const content = openDocument.getText()
      if (
        typeof options.maxBytes === "number" &&
        Number.isSafeInteger(options.maxBytes) &&
        options.maxBytes >= 0 &&
        Buffer.byteLength(content, "utf8") > options.maxBytes
      ) {
        throw new Error(
          `File exceeds the ${options.maxBytes}-byte host read limit`,
        )
      }
      return content
    }
    const uri = vscode.Uri.file(absPath)
    const stat = await vscode.workspace.fs.stat(uri)
    if ((stat.type & vscode.FileType.Directory) !== 0) {
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
    const content = await vscode.workspace.fs.readFile(uri)
    return Buffer.from(content).toString("utf8")
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const absPath = this.resolveWorkspacePath(filePath)
    await this.writeAuthorizedFile(absPath, content)
  }

  async deleteFile(filePath: string): Promise<void> {
    const absPath = this.resolveWorkspacePath(filePath)
    const document = this.findOpenTextDocument(absPath)
    if (document?.isDirty) {
      throw new Error(
        `Refusing to delete ${absPath} while it has unsaved editor changes`,
      )
    }
    const uri = vscode.Uri.file(absPath)
    await vscode.workspace.fs.delete(uri, { useTrash: true })
  }

  async exists(filePath: string): Promise<boolean> {
    const absPath = this.resolveWorkspacePath(filePath)
    const uri = vscode.Uri.file(absPath)
    try {
      await vscode.workspace.fs.stat(uri)
      return true
    } catch {
      return false
    }
  }

  async showDiff(filePath: string, before: string, after: string): Promise<boolean> {
    // Create diff view in VS Code
    const fileName = path.basename(filePath)
    const beforeDoc = await openReadonlyPreviewDocument(before, filePath, `${fileName}:before`)
    const afterDoc = await openReadonlyPreviewDocument(after, filePath, `${fileName}:after`)

    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeDoc.uri,
      afterDoc.uri,
      `${fileName}: NexusCode Changes`,
      { viewColumn: vscode.ViewColumn.Active, preview: true }
    )

    return true
  }

  async runCommand(
    command: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const commandCwd = this.resolveWorkspacePath(cwd || this.cwd)
    if (this.runCommandsInTerminal) {
      const terminal = this.getOrCreateNexusTerminal(commandCwd)
      const integration = await this.waitForShellIntegration(terminal)
      if (integration) {
        terminal.show(true)
        return this.runIntegratedTerminalCommand(terminal, integration, command, signal)
      }
    }
    const { execa } = await import("execa")
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

  async requestMcpAuthentication(request: McpAuthRequest): Promise<McpAuthResult> {
    if (request.startUrl) {
      try {
        const url = parseStrictExternalHttpUrl(request.startUrl)
        await vscode.env.openExternal(vscode.Uri.parse(url.toString()))
        return {
          success: false,
          pending: true,
          message: request.message?.trim() || `Opened authentication URL for ${request.server}.`,
        }
      } catch (error) {
        return {
          success: false,
          message: `Failed to open authentication URL for ${request.server}: ${(error as Error).message}`,
        }
      }
    }
    return {
      success: false,
      message: request.message?.trim() || `No authentication URL available for ${request.server}.`,
    }
  }

  private getOrCreateNexusTerminal(cwd: string): vscode.Terminal {
    const name = "NexusCode"
    const normalizedCwd = path.resolve(cwd || this.cwd)
    const existing = vscode.window.terminals.find((terminal) => {
      if (terminal.name !== name) return false
      const configuredCwd =
        "cwd" in terminal.creationOptions ? terminal.creationOptions.cwd : undefined
      const fsPath =
        typeof configuredCwd === "string"
          ? configuredCwd
          : configuredCwd instanceof vscode.Uri
            ? configuredCwd.fsPath
            : terminal.shellIntegration?.cwd?.fsPath
      return fsPath ? path.resolve(fsPath) === normalizedCwd : false
    })
    if (existing) return existing
    return vscode.window.createTerminal({
      name,
      cwd: normalizedCwd,
    })
  }

  private async waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs = 1500,
  ): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) return terminal.shellIntegration
    terminal.show(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (integration?: vscode.TerminalShellIntegration) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        subscription.dispose()
        resolve(integration)
      }
      const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal === terminal) finish(event.shellIntegration)
      })
      const timeout = setTimeout(() => finish(terminal.shellIntegration), timeoutMs)
    })
  }

  private async runIntegratedTerminalCommand(
    terminal: vscode.Terminal,
    integration: vscode.TerminalShellIntegration,
    command: string,
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (signal?.aborted) return { stdout: "", stderr: "", exitCode: 130 }
    let execution: vscode.TerminalShellExecution | undefined
    let output = ""
    let outputTruncated = false
    let readError = ""
    let finish!: (exitCode: number) => void
    const ended = new Promise<number>((resolve) => {
      finish = resolve
    })
    const endSubscription = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (execution && event.execution === execution) finish(event.exitCode ?? 1)
    })
    execution = integration.executeCommand(command)
    const reader = (async () => {
      for await (const chunk of execution!.read()) {
        output += chunk
        if (output.length > 2_000_000) {
          output = output.slice(-2_000_000)
          outputTruncated = true
        }
      }
    })().catch((error: unknown) => {
      readError = `Failed to capture terminal output: ${error instanceof Error ? error.message : String(error)}`
    })
    const interrupt = () => terminal.sendText("\x03", false)
    let resolveAbort!: () => void
    const aborted = new Promise<number>((resolve) => {
      resolveAbort = () => resolve(130)
      if (signal?.aborted) resolveAbort()
      else signal?.addEventListener("abort", resolveAbort, { once: true })
    })
    signal?.addEventListener("abort", interrupt, { once: true })
    try {
      const exitCode = await Promise.race([ended, aborted])
      await Promise.race([reader, new Promise<void>((resolve) => setTimeout(resolve, 500))])
      return {
        stdout: `${outputTruncated ? "[output truncated to last 2000000 characters]\n" : ""}${output}`
          .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, ""),
        stderr: readError,
        exitCode,
      }
    } finally {
      signal?.removeEventListener("abort", interrupt)
      signal?.removeEventListener("abort", resolveAbort)
      endSubscription.dispose()
    }
  }

  async showApprovalDialog(
    action: ApprovalAction,
    signal?: AbortSignal,
  ): Promise<PermissionResult> {
    const partId = this.emittedApprovalPartId
    this.emittedApprovalPartId = null
    if (signal?.aborted) return { approved: false }

    if (action.type === "doom_loop") {
      const choice = await vscode.window.showWarningMessage(
        `NexusCode: ${action.description}`,
        "Continue",
        "Stop"
      )
      return { approved: choice === "Continue" }
    }

    if (action.type === "read") {
      return { approved: true }
    }

    if (this.sessionAutoApprove) {
      return { approved: true }
    }

    const alwaysKey = approvalGrantKey(action)
    if (this.alwaysApproved.has(alwaysKey)) {
      return { approved: true, alwaysApprove: true }
    }

    if (this.useWebviewApproval && this.approvalResolveRef) {
      if (!partId) {
        throw new Error(
          "Webview approval is missing its exact tool-part identity",
        )
      }
      if (this.approvalResolveRef.current) {
        throw new Error(
          "Cannot replace an unresolved webview approval",
        )
      }
      return new Promise<PermissionResult>((resolve) => {
        let settled = false
        const pending = {
          partId,
          action,
          resolve: (result: PermissionResult) => {
            if (settled) return
            settled = true
            signal?.removeEventListener("abort", onAbort)
            if (result.alwaysApprove) this.alwaysApproved.add(alwaysKey)
            if (result.skipAll) this.sessionAutoApprove = true
            if (this.approvalResolveRef?.current === pending) {
              this.approvalResolveRef.current = null
            }
            resolve(result)
          },
        }
        const onAbort = () => pending.resolve({ approved: false })
        signal?.addEventListener("abort", onAbort, { once: true })
        if (signal?.aborted) onAbort()
        if (!settled) this.approvalResolveRef!.current = pending
      })
    }

    // Native dialog fallback (Cline/Roo-style labels)
    const actionStr =
      action.type === "write"
        ? "write"
        : action.type === "plugin"
          ? "perform this plugin action"
          : action.type === "browser"
            ? "access the public network"
          : "run"
    const buttons: string[] =
      action.type === "execute"
        ? ["Allow once", "Add to allowed for this folder", "Always allow", "Allow all (session)", "Say what to do instead", "Deny"]
        : ["Allow once", "Always allow", "Allow all (session)", "Say what to do instead", "Deny"]

    const message =
      action.type === "execute"
        ? (action.content ? `NexusCode wants to run: ${action.content}` : `NexusCode: ${action.description}`)
        : `NexusCode wants to ${actionStr}: ${action.description}${action.warning ? `\n\n${action.warning}` : ""}`

    const choice = await vscode.window.showInformationMessage(
      message,
      { modal: false },
      ...buttons
    )

    if (choice === "Say what to do instead") {
      const whatToDoInstead = await vscode.window.showInputBox({
        title: "What should the agent do instead?",
        placeHolder: "e.g. Use npm instead of pnpm",
        prompt: "The proposed action will be cancelled; the agent will continue with your instruction.",
      })
      if (whatToDoInstead != null) {
        const trimmed = whatToDoInstead.trim()
        return { approved: false, whatToDoInstead: trimmed || undefined }
      }
      // User cancelled the input — treat as deny
      return { approved: false }
    }

    const approved = choice === "Allow once" || choice === "Always allow" || (action.type === "execute" && choice === "Add to allowed for this folder") || choice === "Allow all (session)"
    const alwaysApprove = choice === "Always allow"
    const skipAll = choice === "Allow all (session)"
    const addToAllowedCommand =
      action.type === "execute" && choice === "Add to allowed for this folder" && action.content
        ? action.content
        : undefined
    if (alwaysApprove) {
      this.alwaysApproved.add(alwaysKey)
    }
    if (skipAll) {
      this.sessionAutoApprove = true
    }
    return { approved, alwaysApprove, skipAll, addToAllowedCommand }
  }

  emit(event: AgentEvent): void {
    if (event.type === "tool_approval_needed") {
      this.emittedApprovalPartId = event.partId
    }
    this.eventEmitter(event)
  }

  async addAllowedCommand(cwd: string, command: string): Promise<void> {
    const normalized = command.trim().replace(/\s+/g, " ")
    if (!normalized) return
    const authorizedCwd = this.resolveWorkspacePath(cwd || this.cwd)
    await grantWorkspaceAuthority(
      authorizedCwd,
      { kind: "command", value: normalized },
      this.authorityStoreOptions,
    )
  }

  async addAllowedPattern(cwd: string, pattern: string): Promise<void> {
    const normalized = pattern.trim()
    if (!normalized) return
    const authorizedCwd = this.resolveWorkspacePath(cwd || this.cwd)
    await grantWorkspaceAuthority(
      authorizedCwd,
      { kind: "command-pattern", value: normalized },
      this.authorityStoreOptions,
    )
  }

  async addAllowedMcpTool(cwd: string, toolName: string): Promise<void> {
    const normalized = toolName.trim()
    if (!normalized) return
    const authorizedCwd = this.resolveWorkspacePath(cwd || this.cwd)
    await grantWorkspaceAuthority(
      authorizedCwd,
      { kind: "mcp-tool", value: normalized },
      this.authorityStoreOptions,
    )
  }

  async getProblems(): Promise<DiagnosticItem[]> {
    const diagnostics: DiagnosticItem[] = []
    const allDiagnostics = vscode.languages.getDiagnostics()
    const cwdResolved = this.resolveWorkspacePath(".")

    for (const [uri, diags] of allDiagnostics) {
      let authorizedPath: string
      try {
        authorizedPath = this.resolveWorkspacePath(uri.fsPath)
      } catch {
        continue
      }
      const rel = path.relative(cwdResolved, authorizedPath)
      const filePath = rel.replace(/\\/g, "/")
      for (const d of diags) {
        diagnostics.push({
          file: filePath,
          line: d.range.start.line + 1,
          col: d.range.start.character + 1,
          severity: d.severity === vscode.DiagnosticSeverity.Error ? "error"
            : d.severity === vscode.DiagnosticSeverity.Warning ? "warning" : "info",
          message: typeof d.message === "string" ? d.message : (d.message as { value: string }).value,
          source: d.source,
        })
      }
    }

    return diagnostics.slice(0, 100)
  }

  async requestModeChange(mode: Mode, reason?: string): Promise<ModeChangeResult> {
    await this.onModeChangeRequested?.(mode, reason)
    return {
      success: true,
      mode,
      message: `Host mode switched to ${mode}.${reason ? ` Reason: ${reason}` : ""}`,
    }
  }

  async setWorkingDirectory(cwd: string, reason?: string): Promise<WorkingDirectoryChangeResult> {
    const authorizedCwd = this.resolveWorkspacePath(cwd)
    await this.onWorkingDirectoryChangeRequested?.(authorizedCwd, reason)
    return {
      success: true,
      cwd: authorizedCwd,
      message: `Host working directory switched to ${authorizedCwd}.${reason ? ` ${reason}` : ""}`,
    }
  }

  async queryLanguageServer(request: LspQueryRequest): Promise<LspQueryResult> {
    if (request.operation === "workspaceSymbol") {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        request.query ?? "",
      )
      const normalized = (symbols ?? [])
        .filter((symbol) =>
          this.isAuthorizedWorkspacePath(symbol.location.uri.fsPath),
        )
        .map((symbol) => workspaceSymbolToCore(symbol))
      return {
        operation: request.operation,
        summary: normalized.length > 0 ? `Found ${normalized.length} workspace symbol(s).` : "No workspace symbols found.",
        symbols: normalized,
      }
    }

    const absolutePath = this.resolveWorkspacePath(request.filePath ?? ".")
    const uri = resolveWorkspaceFileUri(this.cwd, absolutePath)
    const doc = await vscode.workspace.openTextDocument(uri)
    const position = new vscode.Position(Math.max(0, (request.line ?? 1) - 1), Math.max(0, (request.character ?? 1) - 1))

    if (request.operation === "documentSymbol") {
      const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      )
      const normalized = flattenDocumentSymbols(symbols ?? [], absolutePath)
        .filter((symbol) =>
          !symbol.path || this.isAuthorizedWorkspacePath(symbol.path),
        )
      return {
        operation: request.operation,
        summary: normalized.length > 0 ? `Found ${normalized.length} document symbol(s).` : "No document symbols found.",
        symbols: normalized,
      }
    }

    if (request.operation === "hover") {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        position,
      )
      const hover = (hovers ?? []).map(hoverToText).filter(Boolean).join("\n\n").trim()
      return {
        operation: request.operation,
        summary: hover ? "Hover information retrieved." : "No hover information found.",
        hover,
      }
    }

    if (request.operation === "goToDefinition") {
      const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeDefinitionProvider",
        uri,
        position,
      )
      const locations = (definitions ?? [])
        .map(locationLikeToCore)
        .filter((item): item is LspLocation => Boolean(item))
        .filter((item) => this.isAuthorizedWorkspacePath(item.path))
      return {
        operation: request.operation,
        summary: locations.length > 0 ? `Found ${locations.length} definition location(s).` : "No definitions found.",
        locations,
      }
    }

    if (request.operation === "goToImplementation") {
      const implementations = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
        "vscode.executeImplementationProvider",
        uri,
        position,
      )
      const locations = (implementations ?? [])
        .map(locationLikeToCore)
        .filter((item): item is LspLocation => Boolean(item))
        .filter((item) => this.isAuthorizedWorkspacePath(item.path))
      return {
        operation: request.operation,
        summary: locations.length > 0 ? `Found ${locations.length} implementation location(s).` : "No implementations found.",
        locations,
      }
    }

    if (request.operation === "findReferences") {
      const references = await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        uri,
        position,
      )
      const locations = (references ?? [])
        .map(locationLikeToCore)
        .filter((item): item is LspLocation => Boolean(item))
        .filter((item) => this.isAuthorizedWorkspacePath(item.path))
      return {
        operation: request.operation,
        summary: locations.length > 0 ? `Found ${locations.length} reference location(s).` : "No references found.",
        locations,
      }
    }

    const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
      "vscode.prepareCallHierarchy",
      uri,
      position,
    )
    const seed = (items ?? [])[0]
    if (!seed || !this.isAuthorizedWorkspacePath(seed.uri.fsPath)) {
      return {
        operation: request.operation,
        summary: "No call hierarchy available at this symbol.",
      }
    }
    if (request.operation === "prepareCallHierarchy") {
      return {
        operation: request.operation,
        summary: `Prepared call hierarchy for ${seed.name}.`,
        calls: [callHierarchyItemToCore(seed)],
      }
    }
    if (request.operation === "incomingCalls") {
      const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        "vscode.provideIncomingCalls",
        seed,
      )
      const normalizedCalls = (calls ?? [])
        .filter((call) =>
          this.isAuthorizedWorkspacePath(call.from.uri.fsPath),
        )
        .map((call) => ({
          ...callHierarchyItemToCore(call.from),
          fromRanges: call.fromRanges.map(rangeToCore),
        }))
      return {
        operation: request.operation,
        summary: normalizedCalls.length > 0 ? `Found ${normalizedCalls.length} incoming call(s).` : "No incoming calls found.",
        calls: normalizedCalls,
      }
    }
    const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
      "vscode.provideOutgoingCalls",
      seed,
    )
    const normalizedCalls = (calls ?? [])
      .filter((call) => this.isAuthorizedWorkspacePath(call.to.uri.fsPath))
      .map((call) => ({
        ...callHierarchyItemToCore(call.to),
        fromRanges: call.fromRanges.map(rangeToCore),
      }))
    return {
      operation: request.operation,
      summary: normalizedCalls.length > 0 ? `Found ${normalizedCalls.length} outgoing call(s).` : "No outgoing calls found.",
      calls: normalizedCalls,
    }
  }

  async openFileEdit(filePath: string, options: { originalContent: string; newContent: string; isNewFile: boolean }): Promise<void> {
    const key = this.normalizePendingEditKey(filePath)
    // Store pending edit only; do not open diff/editor — user opens file by clicking in chat/UI.
    this.pendingFileEdits.set(key, {
      originalContent: options.originalContent,
      newContent: options.newContent,
      isNewFile: options.isNewFile,
    })
  }

  /** Pending edit snapshot for preview before approval (used by controller showDiff). */
  getPendingFileEdit(filePath: string): { originalContent: string; newContent: string; isNewFile: boolean } | undefined {
    const key = this.normalizePendingEditKey(filePath)
    return this.pendingFileEdits.get(key)
  }

  async saveFileEdit(filePath: string): Promise<void> {
    const key = this.normalizePendingEditKey(filePath)
    const pending = this.pendingFileEdits.get(key)
    if (!pending) throw new Error(`No pending file edit for ${filePath}`)
    const absolutePath = this.resolveWorkspacePath(filePath)
    await this.writeAuthorizedFile(absolutePath, pending.newContent, {
      originalContent: pending.originalContent,
      isNewFile: pending.isNewFile,
    })
    this.onSessionEditSaved?.(filePath, pending.originalContent, pending.newContent, pending.isNewFile)
    this.pendingFileEdits.delete(key)
  }

  /**
   * Restore an already-saved agent edit only while its last written content is
   * still authoritative. Controller Undo/Revert actions use this instead of
   * writing through workspace.fs and potentially clobbering later user edits.
   */
  async revertSavedFileEdit(
    filePath: string,
    edit: {
      originalContent: string
      newContent: string
      isNewFile: boolean
    },
  ): Promise<void> {
    const absolutePath = this.resolveWorkspacePath(filePath)
    if (!edit.isNewFile) {
      await this.writeAuthorizedFile(absolutePath, edit.originalContent, {
        originalContent: edit.newContent,
        isNewFile: false,
      })
      return
    }

    const uri = vscode.Uri.file(absolutePath)
    const document = this.findOpenTextDocument(absolutePath)
    if (document) {
      if (document.isDirty || document.getText() !== edit.newContent) {
        throw new Error(
          `File edit conflict: ${absolutePath} changed in the editor after the agent created it`,
        )
      }
    } else {
      const stat = await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(
        () => undefined,
      )
      if (!stat || (stat.type & vscode.FileType.Directory) !== 0) {
        throw new Error(
          `File edit conflict: ${absolutePath} no longer matches the saved agent edit`,
        )
      }
      const current = Buffer.from(
        await vscode.workspace.fs.readFile(uri),
      ).toString("utf8")
      if (current !== edit.newContent) {
        throw new Error(
          `File edit conflict: ${absolutePath} changed on disk after the agent created it`,
        )
      }
    }
    await vscode.workspace.fs.delete(uri, { useTrash: true })
  }

  async revertFileEdit(filePath: string): Promise<void> {
    const key = this.normalizePendingEditKey(filePath)
    this.pendingFileEdits.delete(key)
  }
}

function getLanguageFromExtension(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescriptreact",
    ".js": "javascript", ".jsx": "javascriptreact",
    ".py": "python", ".rs": "rust", ".go": "go",
    ".java": "java", ".c": "c", ".cpp": "cpp",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml",
    ".md": "markdown",
  }
  return map[ext] ?? "plaintext"
}

function rangeToCore(range: vscode.Range): LspRange {
  return {
    start: { line: range.start.line + 1, character: range.start.character + 1 },
    end: { line: range.end.line + 1, character: range.end.character + 1 },
  }
}

function locationLikeToCore(location: vscode.Location | vscode.LocationLink | undefined): LspLocation | null {
  if (!location) return null
  if ("targetUri" in location) {
      return {
        path: location.targetUri.fsPath,
        range: rangeToCore(location.targetRange),
        ...(location.targetSelectionRange ? { targetSelectionRange: rangeToCore(location.targetSelectionRange) } : {}),
      }
  }
  return {
    path: location.uri.fsPath,
    range: rangeToCore(location.range),
  }
}

function hoverPartToText(part: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof part === "string") return part
  if ("value" in part && typeof part.value === "string") return part.value
  if ("language" in part && typeof part.value === "string") {
    return `\`\`\`${part.language}\n${part.value}\n\`\`\``
  }
  return String(part)
}

function hoverToText(hover: vscode.Hover): string {
  return hover.contents.map(hoverPartToText).filter(Boolean).join("\n\n").trim()
}

function symbolKindLabel(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? String(kind)
}

function symbolToCore(symbol: vscode.DocumentSymbol | vscode.SymbolInformation, fallbackPath: string): LspSymbolRecord[] {
  if ("children" in symbol) {
    const current: LspSymbolRecord = {
      name: symbol.name,
      kind: symbolKindLabel(symbol.kind),
      detail: symbol.detail || undefined,
      path: fallbackPath,
      range: rangeToCore(symbol.selectionRange),
    }
    return [current, ...symbol.children.flatMap((child) => symbolToCore(child, fallbackPath))]
  }
  return [{
    name: symbol.name,
    kind: symbolKindLabel(symbol.kind),
    path: symbol.location.uri.fsPath,
    range: rangeToCore(symbol.location.range),
  }]
}

function flattenDocumentSymbols(symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>, fallbackPath: string): LspSymbolRecord[] {
  return symbols.flatMap((symbol) => symbolToCore(symbol, fallbackPath))
}

function workspaceSymbolToCore(symbol: vscode.SymbolInformation): LspSymbolRecord {
  if ("location" in symbol && symbol.location) {
    const location = symbol.location
    return {
      name: symbol.name,
      kind: symbolKindLabel(symbol.kind),
      path: location.uri.fsPath,
      range: rangeToCore(location.range),
    }
  }
  return {
    name: symbol.name,
    kind: symbolKindLabel(symbol.kind),
  }
}

function callHierarchyItemToCore(item: vscode.CallHierarchyItem): LspCallRecord {
  return {
    name: item.name,
    kind: symbolKindLabel(item.kind),
    path: item.uri.fsPath,
    range: rangeToCore(item.range),
    selectionRange: rangeToCore(item.selectionRange),
  }
}

/**
 * Open VS Code diff view for a file: before = git HEAD version, after = current file.
 * Uses workspace folder URI when available so remote/SSH works (file opens with correct content).
 * Call from webview when user clicks an edited file (e.g. from Editable Files list).
 */
export async function showDiffForPath(cwd: string, filePath: string): Promise<void> {
  let absPath: string
  try {
    absPath = resolveAuthorizedWorkspacePath(cwd, filePath)
  } catch {
    vscode.window.showErrorMessage("NexusCode: Refusing to open a file outside the workspace")
    return
  }
  const canonicalCwd = resolveAuthorizedWorkspacePath(cwd, ".")
  const relPath = path.relative(canonicalCwd, absPath).replace(/\\/g, "/")
  const fileUri = resolveWorkspaceFileUri(cwd, absPath)

  try {
    await vscode.workspace.fs.readFile(fileUri)
  } catch {
    vscode.window.showErrorMessage(`NexusCode: Could not read file ${filePath}`)
    return
  }

  let before = ""
  try {
    const { execa } = await import("execa")
    const res = await execa("git", ["-C", cwd, "show", `HEAD:${relPath}`], { reject: false, timeout: 5000 })
    if (res.exitCode === 0 && res.stdout != null) before = res.stdout
  } catch {
    // New file or not in git — before stays ""
  }

  const fileName = path.basename(filePath)
  const beforeDoc = await openReadonlyPreviewDocument(before, filePath, `${fileName}:before`)

  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeDoc.uri,
    fileUri,
    `${fileName}: NexusCode Changes`,
    { viewColumn: vscode.ViewColumn.Active, preview: false, preserveFocus: false }
  )
}

/**
 * Open VS Code diff view for a session edit: before = original content, after = new content.
 * Used when user clicks a file in the "N Files" panel to review unaccepted session edits.
 */
export async function showSessionEditDiff(
  cwd: string,
  filePath: string,
  before: string,
  after: string,
  options?: { useWorkspaceAfterFile?: boolean }
): Promise<void> {
  const absPath = resolveAuthorizedWorkspacePath(cwd, filePath)
  const fileName = path.basename(filePath)
  const lang = getLanguageFromExtension(path.extname(filePath))
  const beforeDoc = await openReadonlyPreviewDocument(before, filePath, `${fileName}:before`)
  const fileUri = resolveWorkspaceFileUri(cwd, absPath)
  const useWorkspaceAfterFile = options?.useWorkspaceAfterFile !== false
  let afterUri: vscode.Uri
  if (useWorkspaceAfterFile) {
    afterUri = fileUri
    try {
      await vscode.workspace.fs.stat(fileUri)
    } catch {
      const afterDoc = await openReadonlyPreviewDocument(after, filePath, `${fileName}:after`)
      afterUri = afterDoc.uri
    }
  } else {
    const afterDoc = await openReadonlyPreviewDocument(after, filePath, `${fileName}:after`)
    afterUri = afterDoc.uri
  }

  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeDoc.uri,
    afterUri,
    `${fileName}: Session changes`,
    { viewColumn: vscode.ViewColumn.Active, preview: false, preserveFocus: false }
  )
}

export async function openReadonlyTextDiff(
  filePath: string,
  before: string,
  after: string,
  title: string,
): Promise<void> {
  const beforeDoc = await openReadonlyPreviewDocument(before, filePath, `${title}:before`)
  const afterDoc = await openReadonlyPreviewDocument(after, filePath, `${title}:after`)
  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeDoc.uri,
    afterDoc.uri,
    title,
    { viewColumn: vscode.ViewColumn.Active, preview: false, preserveFocus: false }
  )
}

function resolveWorkspaceFileUri(cwd: string, absPath: string): vscode.Uri {
  const canonicalCwd = resolveAuthorizedWorkspacePath(cwd, ".")
  const authorizedPath = resolveAuthorizedWorkspacePath(canonicalCwd, absPath)
  const wf = vscode.workspace.workspaceFolders?.find((folder) => {
    try {
      return resolveAuthorizedWorkspacePath(canonicalCwd, folder.uri.fsPath) === canonicalCwd
    } catch {
      return false
    }
  })
  if (!wf) return vscode.Uri.file(authorizedPath)
  const relPath = path.relative(canonicalCwd, authorizedPath).replace(/\\/g, "/")
  return vscode.Uri.joinPath(wf.uri, relPath)
}
