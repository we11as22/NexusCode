import * as vscode from "vscode"
import { NexusProvider } from "./provider.js"

let provider: NexusProvider | undefined

export function activate(context: vscode.ExtensionContext): void {
  provider = new NexusProvider(context)

  // Register sidebar view provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      NexusProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  )

  // Register the provider itself for disposal
  context.subscriptions.push(provider)

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("nexuscode.openPanel", async () => {
      await provider?.openPanel()
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
    })
  )
}

export function deactivate(): void {
  provider?.dispose()
  provider = undefined
}
