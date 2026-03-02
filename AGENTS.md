# AGENTS.md

This file provides guidance to agents when working with the NexusCode repository.

## Project layout

- **packages/core** — Provider-agnostic agent engine: session, agent loop, tools, indexer, MCP client, checkpoints. No VS Code or CLI dependencies.
- **packages/cli** — Terminal UI (Ink/React), runs the same core agent loop with a CLI host. Events (streaming, tool calls, approvals) are handled in `App.tsx`.
- **packages/vscode** — VS Code extension: webview provider, host adapter (files, diff, approval dialog, terminal). Webview UI is in `webview-ui/` (React + Zustand). Settings and config are applied via `applyVscodeOverrides()` and `saveConfig` from the webview.

## Configuration

- Config is loaded from `.nexus/nexus.yaml` (project) and `~/.nexus/nexus.yaml` (global). Env vars (e.g. `NEXUS_API_KEY`, `OPENROUTER_API_KEY`) override. VS Code settings under `nexuscode.*` override when the extension runs.
- If no config file exists, the extension still gets a default config via `NexusConfigSchema.parse({})` so the Settings UI and agent can run once the user sets an API key in Settings or in the project config.

## Extension ↔ agent

- The extension’s `NexusProvider` owns the session, config, indexer, and MCP client. On `newMessage` it calls `runAgentLoop()` with `VsCodeHost`, which emits `AgentEvent` (e.g. `text_delta`, `tool_start`, `tool_end`, `tool_approval_needed`, `done`, `error`). The provider forwards these to the webview via `postMessage({ type: "agentEvent", event })`.
- The webview store (`stores/chat.ts`) handles these events: `text_delta`/`reasoning_delta` update the last assistant message; `tool_approval_needed` sets `awaitingApproval` (VS Code shows the approval dialog via `VsCodeHost.showApprovalDialog()`); `done`/`error` clear `isRunning` and `awaitingApproval`.

## Settings view

- Settings inputs in the webview bind to a local draft; "Apply Settings" sends `saveConfig` to the extension, which merges into config, writes to `.nexus/nexus.yaml`, and reconnects MCP / reinitializes the indexer when relevant keys change. Do not wire inputs directly to the live extension state; use the same cached draft pattern as in Roo-Code’s SettingsView.

## Indexer

- FTS-only by default. Vector index is used when `indexing.vector` and `vectorDb.enabled` are true and embeddings + Qdrant are available. The factory falls back to FTS-only on missing embeddings or Qdrant. Index status is pushed to the webview via `indexStatus` and `agentEvent` with `index_update`.

## CLI

- Streaming and chat display: `App.tsx` consumes an `AsyncIterable<AgentEvent>`. On `text_delta` it appends to `currentStreaming`; on `done` it appends the final message to `messages`. Scrolling is via `chatScrollLines` (Ctrl+U/D, Ctrl+B/F, PgUp/PgDown). `buildChatLines()` builds the visible lines from `messages`, `liveTools`, `subAgents`, `reasoning`, `currentStreaming`, and errors.

## MCP and skills

- MCP servers are configured in config (`mcp.servers`). The extension connects on init and after `saveConfig` when the MCP section changes. Tools from MCP are registered in the agent’s `ToolRegistry`. Skills are loaded from paths in `config.skills` and can be filtered by the classifier when over the threshold.

## Best practices

- When changing agent loop or host behavior, ensure both CLI and extension hosts are updated (approval dialog, runCommand, emit events).
- When adding new `AgentEvent` types, add handling in both `packages/vscode/webview-ui/src/stores/chat.ts` and `packages/cli/src/tui/App.tsx`.
- Avoid memory leaks: indexer and MCP client are disposed in the provider’s `dispose()`; session is not kept in a global.
