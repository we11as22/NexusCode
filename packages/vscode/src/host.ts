import * as vscode from "vscode"
import * as path from "path"
import type { IHost, AgentEvent, ApprovalAction, PermissionResult, DiagnosticItem } from "@nexuscode/core"

/**
 * VS Code host adapter — bridges the core agent with VS Code APIs.
 */
export class VsCodeHost implements IHost {
  private eventEmitter: (event: AgentEvent) => void
  readonly cwd: string
  private alwaysApproved = new Set<string>()

  constructor(cwd: string, onEvent: (event: AgentEvent) => void) {
    this.cwd = cwd
    this.eventEmitter = onEvent
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

    // For write/execute, show an inline notification
    const actionStr = action.type === "write" ? "Write" : "Execute"
    const detail = action.content
      ? `\n\n${action.content.slice(0, 200)}`
      : action.description

    const choice = await vscode.window.showInformationMessage(
      `NexusCode wants to ${actionStr}: ${action.description}`,
      { modal: false },
      "Allow",
      "Allow Always",
      "Deny"
    )

    const approved = choice === "Allow" || choice === "Allow Always"
    const alwaysApprove = choice === "Allow Always"
    if (alwaysApprove) {
      this.alwaysApproved.add(alwaysKey)
    }
    return { approved, alwaysApprove }
  }

  emit(event: AgentEvent): void {
    this.eventEmitter(event)
  }

  async getProblems(): Promise<DiagnosticItem[]> {
    const diagnostics: DiagnosticItem[] = []
    const allDiagnostics = vscode.languages.getDiagnostics()

    for (const [uri, diags] of allDiagnostics) {
      const filePath = path.relative(this.cwd, uri.fsPath)
      for (const d of diags) {
        diagnostics.push({
          file: filePath,
          line: d.range.start.line + 1,
          col: d.range.start.character + 1,
          severity: d.severity === vscode.DiagnosticSeverity.Error ? "error"
            : d.severity === vscode.DiagnosticSeverity.Warning ? "warning" : "info",
          message: d.message,
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
