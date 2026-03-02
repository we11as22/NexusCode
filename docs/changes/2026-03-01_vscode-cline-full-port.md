# 2026-03-01 — VS Code: full Cline-style port (sources/cline)

## What changed

### Cline-style code action commands
- **Explain Selection** (`nexuscode.explainSelection`): Builds prompt "Explain the following code from **path**: …" and runs the agent in **ask** mode. Available from command palette and editor context menu when there is a selection. If no selection, shows information message.
- **Improve Selection** (`nexuscode.improveSelection`): Builds prompt "Improve the following code from **path** (e.g., refactorings, optimizations, better practices): …" and runs the agent in **agent** mode. Context menu when selection exists.
- **Fix (Diagnostics)** (`nexuscode.fixSelection`): Builds prompt "Fix the following code in **path** … Problems: …" using current file diagnostics (Error/Warning/Info with line and message). Runs in **agent** mode. Context menu when editor has focus (selection optional; uses full file if no selection).

All three commands:
- Call `provider.runAgentWithPrompt(content, mode)` which ensures extension is initialized, focuses the NexusCode sidebar, then runs the agent with the built prompt.
- Are contributed in `package.json` (commands + `editor/context` menus) so they appear in the editor right-click menu and in the command palette under NexusCode.

### Provider API
- **`runAgentWithPrompt(content: string, mode?: Mode)`**: New public method on `NexusProvider`. Runs `ensureInitialized()`, focuses sidebar, then `runAgent(content, mode)`. Used by Explain/Improve/Fix so the agent can be started from extension commands without the user typing in the webview.

### Error path and state
- Verified: On any agent error, the extension sets `isRunning = false` and calls `postStateUpdate()` (in the host emit callback for `event.type === "error"`, and again in `runAgent`'s `finally`). The webview store's `handleAgentEvent("error")` also sets `isRunning: false`. So the UI never stays in "Running" after an error or timeout.

### Diagnostics helper
- **`getDiagnosticsString(uri)`** in `extension.ts`: Formats `vscode.languages.getDiagnostics(uri)` as "Problems:" lines (severity, line:col, message) for the Fix prompt, matching Cline's use of diagnostics in fixWithCline.

## Why
- User requested the same full port for the VS Code extension using Cline (sources/cline): nothing missed, everything thought through. Cline provides Explain/Improve/Fix as code actions that open the chat and run a task with a prefilled prompt; we now match that with dedicated commands and context menu entries, and guaranteed state reset on error.

## Validation
- `pnpm run build` in repo root — passed.
- No linter errors in `packages/vscode/src/extension.ts`, `provider.ts`, or `package.json`.

## References
- Cline: `sources/cline` — `addToCline`, `explainWithCline`, `improveWithCline`, `fixWithCline`; we map to addToChat + Explain/Improve/Fix commands and `runAgentWithPrompt`.
- Existing Cline-aligned UX (approval banner, open at line, settings, projectDir): see `docs/changes/2026-03-01_vscode-cline-ux-open-at-line.md`.
