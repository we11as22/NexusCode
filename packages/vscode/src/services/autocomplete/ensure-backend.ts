import * as vscode from "vscode"

/**
 * Kilocode started a CLI backend when autocomplete toggled on. NexusCode uses the
 * same config as the agent (YAML + VS Code); nothing to spawn here.
 */
export function ensureBackendForAutocomplete(_workspaceRoot?: string): void {
  void vscode.workspace.workspaceFolders
}
