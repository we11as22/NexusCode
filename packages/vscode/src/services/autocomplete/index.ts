import * as vscode from "vscode"
import { AutocompleteServiceManager } from "./AutocompleteServiceManager.js"
import { ensureBackendForAutocomplete } from "./ensure-backend.js"
import type { NexusConfig } from "@nexuscode/core"

/**
 * Register inline completion (ghost text) + status bar + code actions.
 * Uses the same {@link NexusConfig} as the agent (from Controller).
 */
export function registerAutocompleteProvider(
  context: vscode.ExtensionContext,
  getNexusConfig: () => NexusConfig | undefined,
): AutocompleteServiceManager {
  const dir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  ensureBackendForAutocomplete(dir)

  const autocompleteManager = new AutocompleteServiceManager(context, getNexusConfig)
  context.subscriptions.push(autocompleteManager)

  context.subscriptions.push(
    vscode.commands.registerCommand("nexuscode.autocomplete.reload", async () => {
      await autocompleteManager.load()
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("nexuscode.autocomplete.codeActionQuickFix", async () => {
      return
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("nexuscode.autocomplete.cancelSuggestions", () => {
      void vscode.commands.executeCommand("editor.action.inlineSuggest.hide")
      void vscode.commands.executeCommand("setContext", "nexuscode.autocomplete.hasSuggestions", false)
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("nexuscode.autocomplete.generateSuggestions", async () => {
      await autocompleteManager.codeSuggestion()
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("nexuscode.autocomplete.showIncompatibilityExtensionPopup", async () => {
      await autocompleteManager.showIncompatibilityExtensionPopup()
    }),
  )
  context.subscriptions.push(
    vscode.commands.registerCommand("nexuscode.autocomplete.disable", async () => {
      await autocompleteManager.disable()
    }),
  )

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider("*", autocompleteManager.codeActionProvider, {
      providedCodeActionKinds: Object.values(autocompleteManager.codeActionProvider.providedCodeActionKinds),
    }),
  )

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nexuscode")) {
        ensureBackendForAutocomplete(dir)
        void autocompleteManager.load()
      }
    }),
  )

  return autocompleteManager
}
