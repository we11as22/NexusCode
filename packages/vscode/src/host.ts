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
  private checkpointTracker?: { commit(description?: string): Promise<string>; getEntries(): CheckpointEntry[]; resetHead(hash: string): Promise<void>; getDiff(from: string, to?: string): Promise<ChangedFile[]> }
  private useWebviewApproval: boolean
  private approvalResolveRef: { current: ((r: PermissionResult) => void) | null } | null = null

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
    const { execa } = await import("execa")
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

    const alwaysKey = `${action.type}:${action.tool}`
    if (this.alwaysApproved.has(alwaysKey)) {
      return { approved: true, alwaysApprove: true }
    }

    if (this.useWebviewApproval && this.approvalResolveRef) {
      return new Promise<PermissionResult>((resolve) => {
        this.approvalResolveRef!.current = (result: PermissionResult) => {
          if (result.alwaysApprove) this.alwaysApproved.add(alwaysKey)
          this.approvalResolveRef!.current = null
          resolve(result)
        }
      })
    }

    // Native dialog fallback
    const actionStr = action.type === "write" ? "Write" : "Bash"
    const buttons: string[] =
      action.type === "execute"
        ? ["Allow", "Add to allowed for this folder", "Allow Always", "Deny"]
        : ["Allow", "Allow Always", "Deny"]

    const message =
      action.type === "execute"
        ? (action.content ? `NexusCode wants to run: ${action.content}` : `NexusCode: ${action.description}`)
        : `NexusCode wants to ${actionStr}: ${action.description}`

    const choice = await vscode.window.showInformationMessage(
      message,
      { modal: false },
      ...buttons
    )

    const approved = choice === "Allow" || choice === "Allow Always" || (action.type === "execute" && choice === "Add to allowed for this folder")
    const alwaysApprove = choice === "Allow Always"
    const addToAllowedCommand =
      action.type === "execute" && choice === "Add to allowed for this folder" && action.content
        ? action.content
        : undefined
    if (alwaysApprove) {
      this.alwaysApproved.add(alwaysKey)
    }
    return { approved, alwaysApprove, addToAllowedCommand }
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
 * Call from webview when user clicks an edited file (e.g. from Editable Files list).
 */
export async function showDiffForPath(cwd: string, filePath: string): Promise<void> {
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)
  const uri = vscode.Uri.file(absPath)
  let after: string
  try {
    const data = await vscode.workspace.fs.readFile(uri)
    after = Buffer.from(data).toString("utf8")
  } catch {
    vscode.window.showErrorMessage(`NexusCode: Could not read file ${filePath}`)
    return
  }

  const relPath = path.relative(cwd, absPath).replace(/\\/g, "/")
  let before = ""
  try {
    const { execa } = await import("execa")
    const res = await execa("git", ["-C", cwd, "show", `HEAD:${relPath}`], { reject: false, timeout: 5000 })
    if (res.exitCode === 0 && res.stdout != null) before = res.stdout
  } catch {
    // New file or not in git — before stays ""
  }

  const fileName = path.basename(filePath)
  const lang = getLanguageFromExtension(path.extname(filePath))
  const beforeDoc = await vscode.workspace.openTextDocument({
    content: before,
    language: lang,
  })
  const afterDoc = await vscode.workspace.openTextDocument({
    content: after,
    language: lang,
  })
  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeDoc.uri,
    afterDoc.uri,
    `${fileName}: NexusCode Changes`,
    { viewColumn: vscode.ViewColumn.Beside, preview: true }
  )
}
