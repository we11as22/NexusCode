import * as vscode from "vscode"
import * as fs from "node:fs"
import { NexusProvider } from "./provider.js"

let provider: NexusProvider | undefined

export function activate(context: vscode.ExtensionContext): void {
  try {
    fs.appendFileSync("/tmp/nexuscode-extension.log", `[${new Date().toISOString()}] activate()\n`)
  } catch {}
  provider = new NexusProvider(context)
  try {
    fs.appendFileSync("/tmp/nexuscode-extension.log", `[${new Date().toISOString()}] provider created\n`)
  } catch {}
  provider.warmup()
  try {
    fs.appendFileSync("/tmp/nexuscode-extension.log", `[${new Date().toISOString()}] warmup queued\n`)
  } catch {}

  // Register sidebar view provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      NexusProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  )
  try {
    fs.appendFileSync("/tmp/nexuscode-extension.log", `[${new Date().toISOString()}] registerWebviewViewProvider done\n`)
  } catch {}

  // Register the provider itself for disposal
  context.subscriptions.push(provider)

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("nexuscode.openPanel", async () => {
      await provider?.openPanel()
    }),

    vscode.commands.registerCommand("nexuscode.sidebar.focus", () => {
      void vscode.commands.executeCommand("workbench.view.extension.nexuscode-activitybar")
    }),

    vscode.commands.registerCommand("nexuscode.chatClicked", () => {
      provider?.switchView("chat")
      /* Do not run sidebar.focus here — it can open the Explorer on some setups. */
    }),
    vscode.commands.registerCommand("nexuscode.sessionsClicked", () => {
      provider?.switchView("sessions")
      /* Do not run sidebar.focus here — it can open the Explorer on some setups. */
    }),
    vscode.commands.registerCommand("nexuscode.settingsClicked", () => {
      provider?.switchView("settings")
      /* Do not run sidebar.focus here — it can open the Explorer on some setups. */
    }),

    vscode.commands.registerCommand("nexuscode.newTask", () => {
      vscode.commands.executeCommand("nexuscode.sidebar.focus")
    }),

    vscode.commands.registerCommand("nexuscode.addToChat", () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return

      const selection = editor.selection
      const text = editor.document.getText(selection)
      if (!text) return

      const relPath = vscode.workspace.asRelativePath(editor.document.uri)
      const lang = editor.document.languageId
      const content = `**${relPath}**\n\`\`\`${lang}\n${text}\n\`\`\``
      provider?.addToChat(content)
    }),

    vscode.commands.registerCommand("nexuscode.explainSelection", async () => {
      const ctx = getEditorContext()
      if (!ctx?.selectedText) {
        await vscode.window.showInformationMessage("NexusCode: Select some code to explain.")
        return
      }
      const prompt = `Explain the following code from **${ctx.relPath}**:\n\`\`\`${ctx.languageId}\n${ctx.selectedText}\n\`\`\``
      await provider?.runAgentWithPrompt(prompt, "ask")
    }),

    vscode.commands.registerCommand("nexuscode.improveSelection", async () => {
      const ctx = getEditorContext()
      if (!ctx?.selectedText) {
        await vscode.window.showInformationMessage("NexusCode: Select some code to improve.")
        return
      }
      const prompt = `Improve the following code from **${ctx.relPath}** (e.g., suggest refactorings, optimizations, or better practices):\n\`\`\`${ctx.languageId}\n${ctx.selectedText}\n\`\`\``
      await provider?.runAgentWithPrompt(prompt, "agent")
    }),

    vscode.commands.registerCommand("nexuscode.fixSelection", async () => {
      const ctx = getEditorContext()
      if (!ctx) return
      const problems = getDiagnosticsString(ctx.uri)
      const prompt = `Fix the following code in **${ctx.relPath}**\n\`\`\`\n${ctx.selectedText || ctx.documentText}\n\`\`\`\n\nProblems:\n${problems}`
      await provider?.runAgentWithPrompt(prompt, "agent")
    }),

    vscode.commands.registerCommand("nexuscode.compact", () => {
      vscode.commands.executeCommand("nexuscode.sidebar.focus")
    }),

    vscode.commands.registerCommand("nexuscode.clearChat", () => {
      vscode.commands.executeCommand("nexuscode.sidebar.focus")
    }),

    vscode.commands.registerCommand("nexuscode.reindex", async () => {
      await provider?.reindex()
      vscode.window.showInformationMessage("NexusCode: Re-indexing codebase...")
    }),

    vscode.commands.registerCommand("nexuscode.clearIndex", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "NexusCode: Clear the entire codebase index and re-build it from scratch?",
        "Clear & Rebuild",
        "Cancel"
      )
      if (confirm === "Clear & Rebuild") {
        await provider?.clearIndex()
        vscode.window.showInformationMessage("NexusCode: Index cleared. Re-indexing...")
      }
    }),

    vscode.commands.registerCommand("nexuscode.openTerminal", () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
      const existing = vscode.window.terminals.find((t) => t.name === "NexusCode")
      const term = existing ?? vscode.window.createTerminal({ name: "NexusCode", cwd })
      term.show()
    })
  )
}

export function deactivate(): void {
  provider?.dispose()
  provider = undefined
}

function getEditorContext(): {
  uri: vscode.Uri
  relPath: string
  languageId: string
  selectedText: string
  documentText: string
} | undefined {
  const editor = vscode.window.activeTextEditor
  if (!editor) return undefined
  const doc = editor.document
  const selection = editor.selection
  const selectedText = doc.getText(selection)
  const documentText = doc.getText()
  return {
    uri: doc.uri,
    relPath: vscode.workspace.asRelativePath(doc.uri),
    languageId: doc.languageId,
    selectedText,
    documentText,
  }
}

function getDiagnosticsString(uri: vscode.Uri): string {
  const list = vscode.languages.getDiagnostics(uri)
  if (list.length === 0) return "No problems reported."
  return list
    .map((d) => {
      const severity = ["Error", "Warning", "Info", "Hint"][d.severity ?? 0] ?? "Info"
      const range = `${d.range.start.line + 1}:${d.range.start.character}`
      return `- [${severity}] ${range}: ${d.message}`
    })
    .join("\n")
}
