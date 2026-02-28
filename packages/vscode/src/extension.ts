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

  // Commands
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
      // Trigger compact via webview message
      vscode.commands.executeCommand("nexuscode.sidebar.focus")
    }),

    vscode.commands.registerCommand("nexuscode.clearChat", () => {
      vscode.commands.executeCommand("nexuscode.sidebar.focus")
    })
  )
}

export function deactivate(): void {}
