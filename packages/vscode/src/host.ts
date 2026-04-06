import * as vscode from "vscode"
import * as path from "path"
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
} from "@nexuscode/core"

const NEXUS_PREVIEW_SCHEME = "nexuscode-preview"
const previewDocuments = new Map<string, string>()
let previewProviderRegistration: vscode.Disposable | undefined

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
  private approvalResolveRef: { current: ((r: PermissionResult) => void) | null } | null = null
  private onCheckpointEntriesUpdated?: () => void
  /** Called after an approved edit is written to disk; used to add to session unaccepted list. */
  private onSessionEditSaved?: (path: string, originalContent: string, newContent: string, isNewFile: boolean) => void

  private pendingFileEdits = new Map<string, { originalContent: string; newContent: string; isNewFile: boolean }>()

  private normalizePendingEditKey(filePath: string): string {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.cwd, filePath)
    return path.normalize(absPath).replace(/\\/g, "/")
  }

  constructor(
    cwd: string,
    onEvent: (event: AgentEvent) => void,
    options?: {
      useWebviewApproval?: boolean
      approvalResolveRef?: { current: ((r: PermissionResult) => void) | null }
      onCheckpointEntriesUpdated?: () => void
      onSessionEditSaved?: (path: string, originalContent: string, newContent: string, isNewFile: boolean) => void
      onModeChangeRequested?: (mode: Mode, reason?: string) => Promise<void> | void
      onWorkingDirectoryChangeRequested?: (cwd: string, reason?: string) => Promise<void> | void
    }
  ) {
    this.cwd = cwd
    this.eventEmitter = onEvent
    this.useWebviewApproval = options?.useWebviewApproval ?? false
    this.approvalResolveRef = options?.approvalResolveRef ?? null
    this.onCheckpointEntriesUpdated = options?.onCheckpointEntriesUpdated
    this.onSessionEditSaved = options?.onSessionEditSaved
    this.onModeChangeRequested = options?.onModeChangeRequested
    this.onWorkingDirectoryChangeRequested = options?.onWorkingDirectoryChangeRequested
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

  async readFile(filePath: string): Promise<string> {
    const absPath = filePath.startsWith("/") ? filePath : path.join(this.cwd, filePath)
    const uri = vscode.Uri.file(absPath)
    const content = await vscode.workspace.fs.readFile(uri)
    return Buffer.from(content).toString("utf8")
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const absPath = filePath.startsWith("/") ? filePath : path.join(this.cwd, filePath)
    const dir = path.dirname(absPath)
    const cwdResolved = path.resolve(this.cwd)
    const relDir = path.relative(cwdResolved, dir)
    if (relDir && !relDir.startsWith("..") && relDir !== ".") {
      const parts = relDir.split(path.sep)
      let acc = cwdResolved
      for (const p of parts) {
        if (!p) continue
        acc = path.join(acc, p)
        try {
          await vscode.workspace.fs.createDirectory(vscode.Uri.file(acc))
        } catch {
          // Dir may already exist
        }
      }
    }
    const uri = vscode.Uri.file(absPath)
    const encoder = new TextEncoder()
    await vscode.workspace.fs.writeFile(uri, encoder.encode(content))
  }

  async deleteFile(filePath: string): Promise<void> {
    const absPath = filePath.startsWith("/") ? filePath : path.join(this.cwd, filePath)
    const uri = vscode.Uri.file(absPath)
    await vscode.workspace.fs.delete(uri, { useTrash: true })
  }

  async exists(filePath: string): Promise<boolean> {
    const absPath = filePath.startsWith("/") ? filePath : path.join(this.cwd, filePath)
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
    const { execa } = await import("execa")
    const result = await execa(command, {
      shell: true,
      cwd,
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
        await vscode.env.openExternal(vscode.Uri.parse(request.startUrl))
        return {
          success: true,
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
    const existing = vscode.window.terminals.find((t) => t.name === name)
    if (existing) return existing
    return vscode.window.createTerminal({
      name,
      cwd: cwd || this.cwd,
    })
  }

  async showApprovalDialog(action: ApprovalAction): Promise<PermissionResult> {
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

    const alwaysKey = `${action.type}:${action.tool}`
    if (this.alwaysApproved.has(alwaysKey)) {
      return { approved: true, alwaysApprove: true }
    }

    if (this.useWebviewApproval && this.approvalResolveRef) {
      return new Promise<PermissionResult>((resolve) => {
        this.approvalResolveRef!.current = (result: PermissionResult) => {
          if (result.alwaysApprove) this.alwaysApproved.add(alwaysKey)
          if (result.skipAll) this.sessionAutoApprove = true
          this.approvalResolveRef!.current = null
          resolve(result)
        }
      })
    }

    // Native dialog fallback (Cline/Roo-style labels)
    const actionStr = action.type === "write" ? "Write" : "Bash"
    const buttons: string[] =
      action.type === "execute"
        ? ["Allow once", "Add to allowed for this folder", "Always allow", "Allow all (session)", "Say what to do instead", "Deny"]
        : ["Allow once", "Always allow", "Allow all (session)", "Say what to do instead", "Deny"]

    const message =
      action.type === "execute"
        ? (action.content ? `NexusCode wants to run: ${action.content}` : `NexusCode: ${action.description}`)
        : `NexusCode wants to ${actionStr}: ${action.description}`

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
    this.eventEmitter(event)
  }

  async addAllowedCommand(cwd: string, command: string): Promise<void> {
    const normalized = command.trim().replace(/\s+/g, " ")
    if (!normalized) return
    const dirUri = vscode.Uri.file(path.join(cwd, ".nexus"))
    const fileUri = vscode.Uri.file(path.join(cwd, ".nexus", "allowed-commands.json"))
    let commands: string[] = []
    try {
      const data = await vscode.workspace.fs.readFile(fileUri)
      const parsed = JSON.parse(Buffer.from(data).toString("utf8")) as { commands?: string[] }
      if (Array.isArray(parsed?.commands)) commands = [...parsed.commands]
    } catch {
      // File missing or invalid
    }
    if (commands.includes(normalized)) return
    commands.push(normalized)
    try {
      await vscode.workspace.fs.createDirectory(dirUri)
    } catch {
      // Dir may exist
    }
    await vscode.workspace.fs.writeFile(
      fileUri,
      new TextEncoder().encode(JSON.stringify({ commands }, null, 2))
    )

    await this.appendToSettingsAllow(cwd, normalized)
  }

  async addAllowedPattern(cwd: string, pattern: string): Promise<void> {
    const normalized = pattern.trim()
    if (!normalized) return
    await this.appendToSettingsAllow(cwd, normalized)
  }

  async addAllowedMcpTool(cwd: string, toolName: string): Promise<void> {
    const normalized = toolName.trim()
    if (!normalized) return
    const dir = path.join(cwd, ".nexus")
    const settings = await this.readSettingsLocal(cwd)
    if (!settings.permissions) settings.permissions = {}
    const list = settings.permissions.allowedMcpTools ?? []
    if (list.includes(normalized)) return
    settings.permissions.allowedMcpTools = [...list, normalized]
    if (!settings.permissions.allow) settings.permissions.allow = []
    if (!settings.permissions.deny) settings.permissions.deny = []
    if (!settings.permissions.ask) settings.permissions.ask = []
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir))
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(dir, "settings.local.json")),
      new TextEncoder().encode(JSON.stringify(settings, null, 2))
    )
    await this.mirrorClaudeSettingsLocal(cwd, settings)
  }

  private async readSettingsLocal(cwd: string): Promise<{
    permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; allowedMcpTools?: string[] }
  }> {
    const settingsLocalPath = path.join(cwd, ".nexus", "settings.local.json")
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(settingsLocalPath))
      const parsed = JSON.parse(Buffer.from(data).toString("utf8")) as {
        permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; allowedMcpTools?: string[] }
      }
      if (parsed && typeof parsed === "object") return parsed
      return {}
    } catch {
      return {}
    }
  }

  private async appendToSettingsAllow(cwd: string, entry: string): Promise<void> {
    const dir = path.join(cwd, ".nexus")
    const settings = await this.readSettingsLocal(cwd)
    if (!settings.permissions) settings.permissions = {}
    const allow = settings.permissions.allow ?? []
    if (allow.includes(entry)) return
    settings.permissions.allow = [...allow, entry]
    if (!settings.permissions.deny) settings.permissions.deny = []
    if (!settings.permissions.ask) settings.permissions.ask = []
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir))
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(dir, "settings.local.json")),
      new TextEncoder().encode(JSON.stringify(settings, null, 2))
    )
    await this.mirrorClaudeSettingsLocal(cwd, settings)
  }

  private async mirrorClaudeSettingsLocal(cwd: string, settings: {
    permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; allowedMcpTools?: string[] }
  }): Promise<void> {
    const claudeDir = path.join(cwd, ".claude")
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(claudeDir))
      if (stat.type !== vscode.FileType.Directory) return
    } catch {
      return
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(claudeDir))
    await vscode.workspace.fs.writeFile(
      vscode.Uri.file(path.join(claudeDir, "settings.local.json")),
      new TextEncoder().encode(JSON.stringify(settings, null, 2)),
    )
  }

  async getProblems(): Promise<DiagnosticItem[]> {
    const diagnostics: DiagnosticItem[] = []
    const allDiagnostics = vscode.languages.getDiagnostics()
    const cwdResolved = path.resolve(this.cwd)

    for (const [uri, diags] of allDiagnostics) {
      const rel = path.relative(cwdResolved, uri.fsPath)
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue
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
    await this.onWorkingDirectoryChangeRequested?.(cwd, reason)
    return {
      success: true,
      cwd,
      message: `Host working directory switched to ${cwd}.${reason ? ` ${reason}` : ""}`,
    }
  }

  async queryLanguageServer(request: LspQueryRequest): Promise<LspQueryResult> {
    if (request.operation === "workspaceSymbol") {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        request.query ?? "",
      )
      const normalized = (symbols ?? []).map((symbol) => workspaceSymbolToCore(symbol))
      return {
        operation: request.operation,
        summary: normalized.length > 0 ? `Found ${normalized.length} workspace symbol(s).` : "No workspace symbols found.",
        symbols: normalized,
      }
    }

    const absolutePath = request.filePath
      ? (path.isAbsolute(request.filePath) ? request.filePath : path.join(this.cwd, request.filePath))
      : this.cwd
    const uri = resolveWorkspaceFileUri(this.cwd, absolutePath)
    const doc = await vscode.workspace.openTextDocument(uri)
    const position = new vscode.Position(Math.max(0, (request.line ?? 1) - 1), Math.max(0, (request.character ?? 1) - 1))

    if (request.operation === "documentSymbol") {
      const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      )
      const normalized = flattenDocumentSymbols(symbols ?? [], absolutePath)
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
      const locations = (definitions ?? []).map(locationLikeToCore).filter((item): item is LspLocation => Boolean(item))
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
      const locations = (implementations ?? []).map(locationLikeToCore).filter((item): item is LspLocation => Boolean(item))
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
      const locations = (references ?? []).map(locationLikeToCore).filter((item): item is LspLocation => Boolean(item))
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
    if (!seed) {
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
      return {
        operation: request.operation,
        summary: (calls ?? []).length > 0 ? `Found ${(calls ?? []).length} incoming call(s).` : "No incoming calls found.",
        calls: (calls ?? []).map((call) => ({
          ...callHierarchyItemToCore(call.from),
          fromRanges: call.fromRanges.map(rangeToCore),
        })),
      }
    }
    const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
      "vscode.provideOutgoingCalls",
      seed,
    )
    return {
      operation: request.operation,
      summary: (calls ?? []).length > 0 ? `Found ${(calls ?? []).length} outgoing call(s).` : "No outgoing calls found.",
      calls: (calls ?? []).map((call) => ({
        ...callHierarchyItemToCore(call.to),
        fromRanges: call.fromRanges.map(rangeToCore),
      })),
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
    // Persist approved content to disk (file does not open here; user opens by clicking in chat/UI).
    await this.writeFile(filePath, pending.newContent)
    this.onSessionEditSaved?.(filePath, pending.originalContent, pending.newContent, pending.isNewFile)
    this.pendingFileEdits.delete(key)
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
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
  const relPath = path.relative(cwd, absPath).replace(/\\/g, "/")
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
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
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
  const wf = vscode.workspace.workspaceFolders?.[0]
  if (!wf) return vscode.Uri.file(absPath)
  const relPath = path.relative(cwd, absPath).replace(/\\/g, "/")
  if (relPath.startsWith("..") || path.isAbsolute(relPath)) {
    return vscode.Uri.file(absPath)
  }
  return vscode.Uri.joinPath(wf.uri, relPath)
}
