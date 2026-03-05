import * as vscode from "vscode"
import * as path from "path"
import type { IHost, AgentEvent, ApprovalAction, PermissionResult, DiagnosticItem, CheckpointEntry, ChangedFile } from "@nexuscode/core"

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

  private pendingFileEdits = new Map<string, { originalContent: string; newContent: string; isNewFile: boolean; leftUri?: vscode.Uri; rightUri?: vscode.Uri }>()

  constructor(
    cwd: string,
    onEvent: (event: AgentEvent) => void,
    options?: { useWebviewApproval?: boolean; approvalResolveRef?: { current: ((r: PermissionResult) => void) | null } }
  ) {
    this.cwd = cwd
    this.eventEmitter = onEvent
    this.useWebviewApproval = options?.useWebviewApproval ?? false
    this.approvalResolveRef = options?.approvalResolveRef ?? null
  }

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
    const beforeDoc = await vscode.workspace.openTextDocument({
      content: before,
      language: getLanguageFromExtension(path.extname(filePath)),
    })
    const afterDoc = await vscode.workspace.openTextDocument({
      content: after,
      language: getLanguageFromExtension(path.extname(filePath)),
    })

    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeDoc.uri,
      afterDoc.uri,
      `${fileName}: NexusCode Changes`,
      { viewColumn: vscode.ViewColumn.Beside, preview: true }
    )

    return true
  }

  async runCommand(
    command: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const runInTerminal = vscode.workspace.getConfiguration("nexuscode").get<boolean>("runCommandsInTerminal") ?? true
    if (runInTerminal) {
      try {
        return await this.runCommandInTerminal(command, cwd, signal)
      } catch (e) {
        // Fallback to execa if terminal run fails (e.g. timeout, no terminal)
        const { execa } = await import("execa")
        const result = await execa(command, {
          shell: true,
          cwd,
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
    }
    const { execa } = await import("execa")
    const result = await execa(command, {
      shell: true,
      cwd,
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

  /** Run command in VS Code integrated terminal (Cline-style); capture output via end marker. */
  private async runCommandInTerminal(
    command: string,
    cwd: string,
    signal?: AbortSignal
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const START_MARKER = "__NEXUSCODE_START__"
    const DONE_MARKER = "__NEXUSCODE_DONE_"
    const timeoutMs = 120_000

    const term = this.getOrCreateNexusTerminal(cwd)
    term.show(true)

    return new Promise((resolve, reject) => {
      let buffer = ""
      let started = false
      const cleanup = () => {
        sub?.dispose()
        signal?.removeEventListener("abort", onAbort)
        clearTimeout(timeoutId)
      }
      const onAbort = () => {
        cleanup()
        reject(new DOMException("Command aborted", "AbortError"))
      }
      signal?.addEventListener("abort", onAbort)
      const timeoutId = setTimeout(() => {
        cleanup()
        const match = buffer.match(new RegExp(`${DONE_MARKER}(\\d+)`))
        const exitCode = match ? parseInt(match[1]!, 10) : 124
        const out = started
          ? buffer.replace(new RegExp(`\\n?[^\\n]*${DONE_MARKER}\\d+[^\\n]*`, "g"), "").trim()
          : buffer.trim()
        resolve({ stdout: out, stderr: "", exitCode })
      }, timeoutMs)

      const sub = term.onDidWriteData((data: string) => {
        buffer += data
        if (!started && buffer.includes(START_MARKER)) {
          started = true
          buffer = buffer.slice(buffer.indexOf(START_MARKER) + START_MARKER.length)
        }
        if (!started) return
        const match = buffer.match(new RegExp(`${DONE_MARKER}(\\d+)`))
        if (match) {
          cleanup()
          const exitCode = parseInt(match[1]!, 10)
          const out = buffer.replace(new RegExp(`\\n?[^\\n]*${DONE_MARKER}\\d+[^\\n]*`, "g"), "").trim()
          resolve({ stdout: out, stderr: "", exitCode })
        }
      })

      term.sendText(`echo '${START_MARKER}'; ${command}; echo '${DONE_MARKER}'$?`)
    })
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
        ? ["Allow once", "Add to allowed for this folder", "Always allow", "Allow all (session)", "Deny"]
        : ["Allow once", "Always allow", "Allow all (session)", "Deny"]

    const message =
      action.type === "execute"
        ? (action.content ? `NexusCode wants to run: ${action.content}` : `NexusCode: ${action.description}`)
        : `NexusCode wants to ${actionStr}: ${action.description}`

    const choice = await vscode.window.showInformationMessage(
      message,
      { modal: false },
      ...buttons
    )

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

    // Also append to .nexus/settings.local.json (like .claude) so the allowlist is visible
    const settingsLocalPath = path.join(cwd, ".nexus", "settings.local.json")
    let settings: { permissions?: { allow?: string[]; deny?: string[]; ask?: string[] } } = {}
    try {
      const settingsUri = vscode.Uri.file(settingsLocalPath)
      const data = await vscode.workspace.fs.readFile(settingsUri)
      settings = JSON.parse(Buffer.from(data).toString("utf8")) as typeof settings
    } catch {
      // File missing or invalid
    }
    if (!settings.permissions) settings.permissions = {}
    const allow = settings.permissions.allow ?? []
    if (!allow.includes(normalized)) {
      allow.push(normalized)
      settings.permissions.allow = allow
      if (!settings.permissions.deny) settings.permissions.deny = []
      if (!settings.permissions.ask) settings.permissions.ask = []
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(settingsLocalPath),
        new TextEncoder().encode(JSON.stringify(settings, null, 2))
      )
    }
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

  async openFileEdit(filePath: string, options: { originalContent: string; newContent: string; isNewFile: boolean }): Promise<void> {
    const key = filePath.replace(/\\/g, "/")
    const absPath = filePath.startsWith("/") ? filePath : path.join(this.cwd, filePath)
    const base = path.basename(absPath)
    const leftUri = vscode.Uri.parse(`untitled:${absPath}.nexus-original`)
    const rightUri = vscode.Uri.parse(`untitled:${absPath}.nexus-modified`)
    const leftDoc = await vscode.workspace.openTextDocument(leftUri)
    const rightDoc = await vscode.workspace.openTextDocument(rightUri)
    const we = new vscode.WorkspaceEdit()
    we.insert(leftUri, new vscode.Position(0, 0), options.originalContent)
    we.insert(rightUri, new vscode.Position(0, 0), options.newContent)
    await vscode.workspace.applyEdit(we)
    await vscode.commands.executeCommand("vscode.diff", leftDoc.uri, rightDoc.uri, `${base}: NexusCode (Approve to save, Deny to revert)`, { viewColumn: vscode.ViewColumn.Beside, preview: true })
    this.pendingFileEdits.set(key, { originalContent: options.originalContent, newContent: options.newContent, isNewFile: options.isNewFile, leftUri, rightUri })
  }

  async saveFileEdit(filePath: string): Promise<void> {
    const key = filePath.replace(/\\/g, "/")
    const pending = this.pendingFileEdits.get(key)
    if (!pending) throw new Error(`No pending file edit for ${filePath}`)
    await this.writeFile(filePath, pending.newContent)
    this.pendingFileEdits.delete(key)
  }

  async revertFileEdit(filePath: string): Promise<void> {
    const key = filePath.replace(/\\/g, "/")
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

/**
 * Open VS Code diff view for a file: before = git HEAD version, after = current file.
 * Uses workspace folder URI when available so remote/SSH works (file opens with correct content).
 * Call from webview when user clicks an edited file (e.g. from Editable Files list).
 */
export async function showDiffForPath(cwd: string, filePath: string): Promise<void> {
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
  const relPath = path.relative(cwd, absPath).replace(/\\/g, "/")

  // Use workspace folder URI so on SSH/remote we read the file from the same resource as the workspace.
  const wf = vscode.workspace.workspaceFolders?.[0]
  const fileUri = wf
    ? vscode.Uri.joinPath(wf.uri, relPath)
    : vscode.Uri.file(absPath)

  let after: string
  try {
    const data = await vscode.workspace.fs.readFile(fileUri)
    after = Buffer.from(data).toString("utf8")
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

  // Use untitled URIs so the tab shows a path hint (filename in save dialog).
  const dir = path.dirname(absPath)
  const base = path.basename(absPath)
  const uriAfter = vscode.Uri.parse("untitled:" + absPath)
  const uriBefore = vscode.Uri.parse("untitled:" + path.join(dir, ".nexuscode-diff-before", base))

  const beforeDoc = await vscode.workspace.openTextDocument(uriBefore)
  const afterDoc = await vscode.workspace.openTextDocument(uriAfter)

  const we = new vscode.WorkspaceEdit()
  we.insert(uriBefore, new vscode.Position(0, 0), before)
  we.insert(uriAfter, new vscode.Position(0, 0), after)
  await vscode.workspace.applyEdit(we)

  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeDoc.uri,
    afterDoc.uri,
    `${fileName}: NexusCode Changes`,
    { viewColumn: vscode.ViewColumn.Beside, preview: true }
  )
}
