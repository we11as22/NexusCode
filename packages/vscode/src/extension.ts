import * as vscode from "vscode"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolveSandboxBinary } from "@nexuscode/sandbox"
import { NexusProvider } from "./provider.js"

let provider: NexusProvider | undefined
const execFileAsync = promisify(execFile)

export function activate(context: vscode.ExtensionContext): void {
  provider = new NexusProvider(context)
  provider.warmup()
  void offerWindowsSandboxSetup()

  // Register sidebar view provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      NexusProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerWebviewPanelSerializer("nexuscode.panel", {
      async deserializeWebviewPanel(webviewPanel) {
        // Versions before 0.1.0 could persist a second, editor-hosted copy of
        // the chat. Retire it on restore so one controller has one UI surface.
        webviewPanel.dispose()
        await vscode.commands.executeCommand("workbench.view.extension.nexuscode-activitybar")
      },
    }),
  )

  // Register the provider itself for disposal
  context.subscriptions.push(provider)

  // ── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("nexuscode.openPanel", async () => {
      await vscode.commands.executeCommand("workbench.view.extension.nexuscode-activitybar")
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

    vscode.commands.registerCommand("nexuscode.newTask", async () => {
      await provider?.createNewSession()
      await vscode.commands.executeCommand("nexuscode.sidebar.focus")
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

    vscode.commands.registerCommand("nexuscode.compact", async () => {
      await provider?.compact()
      await vscode.commands.executeCommand("nexuscode.sidebar.focus")
    }),

    vscode.commands.registerCommand("nexuscode.clearChat", async () => {
      await provider?.clearChat()
      await vscode.commands.executeCommand("nexuscode.sidebar.focus")
    }),

    vscode.commands.registerCommand("nexuscode.reindex", async () => {
      await provider?.reindex()
      vscode.window.showInformationMessage("NexusCode: Syncing index (incremental update, no full wipe)...")
    }),

    vscode.commands.registerCommand("nexuscode.clearIndex", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "NexusCode: Delete the entire index for this workspace (file tracker + Qdrant collection)? Nothing is rebuilt automatically — use Re-index to sync again.",
        { modal: true },
        "Delete index",
        "Cancel",
      )
      if (confirm === "Delete index") {
        await provider?.clearIndex()
        vscode.window.showInformationMessage("NexusCode: Index deleted.")
      }
    }),

    vscode.commands.registerCommand("nexuscode.fullRebuildIndex", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "NexusCode: Wipe the index and rebuild from scratch? This clears the tracker and vector collection, then re-indexes everything.",
        { modal: true },
        "Rebuild",
        "Cancel",
      )
      if (confirm === "Rebuild") {
        await provider?.fullRebuildIndex()
        vscode.window.showInformationMessage("NexusCode: Full rebuild started.")
      }
    }),

    vscode.commands.registerCommand("nexuscode.deleteIndexHere", async (uri: vscode.Uri) => {
      if (!uri) {
        vscode.window.showInformationMessage("NexusCode: Run this command from the Explorer context menu on a file or folder.")
        return
      }
      await provider?.deleteIndexForResource(uri)
    }),

    vscode.commands.registerCommand("nexuscode.openTerminal", () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
      const existing = vscode.window.terminals.find((t) => t.name === "NexusCode")
      const term = existing ?? vscode.window.createTerminal({ name: "NexusCode", cwd })
      term.show()
    }),

    vscode.commands.registerCommand("nexuscode.setupWindowsSandbox", async () => {
      if (process.platform !== "win32") {
        await vscode.window.showInformationMessage(
          "NexusCode: Explicit OS sandbox setup is only required on Windows.",
        )
        return
      }
      try {
        const helper = resolveSandboxBinary()
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "NexusCode: Configuring Windows sandbox…",
            cancellable: false,
          },
          async () => {
            await execFileAsync(helper, ["--setup"], {
              windowsHide: true,
              maxBuffer: 1024 * 1024,
            })
            await execFileAsync(helper, ["--check"], {
              windowsHide: true,
              maxBuffer: 1024 * 1024,
            })
          },
        )
        await vscode.window.showInformationMessage(
          "NexusCode: Windows sandbox is ready.",
        )
      } catch (error) {
        await vscode.window.showErrorMessage(
          `NexusCode: Windows sandbox setup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }),
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

async function offerWindowsSandboxSetup(): Promise<void> {
  if (process.platform !== "win32") return
  try {
    const helper = resolveSandboxBinary()
    const { stdout } = await execFileAsync(helper, ["--status-json"], {
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
    const status = JSON.parse(stdout) as { state?: string; detail?: string }
    if (status.state === "ready") {
      try {
        await execFileAsync(helper, ["--check"], {
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        })
        return
      } catch (error) {
        status.detail =
          `The saved setup is present but its security probe failed: ${
            error instanceof Error ? error.message : String(error)
          }`
      }
    }
    const action = await vscode.window.showWarningMessage(
      `NexusCode: Windows OS sandbox is ${status.state ?? "not ready"}. ` +
        `${status.detail ?? "Setup is required before agent commands can run."}`,
      "Set up sandbox",
    )
    if (action === "Set up sandbox") {
      await vscode.commands.executeCommand("nexuscode.setupWindowsSandbox")
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `NexusCode: Could not inspect the Windows sandbox: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}
