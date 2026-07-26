# AGENTS.md

This file provides guidance to agents when working with the NexusCode repository.

## Project layout

- **packages/core** — Provider-agnostic agent engine: session, agent loop, tools, indexer, MCP client, checkpoints. No VS Code or CLI dependencies.
- **packages/cli** — Terminal UI (Ink/React), runs the same core agent loop with a CLI host. `src/index.ts` lazily enters `entrypoints/cli.tsx`; `nexus-query.ts` bridges `AgentEvent` into `screens/REPL.tsx` and the message components.
- **packages/vscode** — VS Code extension: webview provider, host adapter (files, diff, approval dialog, terminal). Webview UI is in `webview-ui/` (React + Zustand). Settings and config are applied via `applyVscodeOverrides()` and `saveConfig` from the webview.

## Configuration

- Config is loaded from `.nexus/nexus.yaml` (project) and `~/.nexus/nexus.yaml` (global). Env vars (e.g. `NEXUS_API_KEY`, `OPENROUTER_API_KEY`) override. VS Code settings under `nexuscode.*` override when the extension runs.
- **API keys (secrets)** are never written to YAML or contributed as plaintext VS Code settings. Precedence: env vars → secrets store → config file. Extension uses VS Code Secret Storage (`context.secrets`) and migrates legacy explicit settings; CLI uses `~/.nexus/secrets.json` (mode 0o600). Model, embeddings, autocomplete, and **per-profile API keys** are stored in the secrets store; webview configuration receives only presence flags and redacted config.
- **Env substitution** in config files: use `{env:VAR_NAME}` in YAML/JSON values to substitute `process.env.VAR_NAME` at load time (e.g. `apiKey: "{env:OPENROUTER_API_KEY}"` — key still not written on save).
- **File substitution**: use `{file:path}` to inject file contents at load time; path is relative to the config file or `~/` for home. Useful for keys in a separate file (e.g. `apiKey: "{file:~/.nexus/key.txt}"`).
- If no config file exists, the extension still gets a default config via `NexusConfigSchema.parse({})` so the Settings UI and agent can run once the user sets an API key in Settings or in the secrets store.

## Extension ↔ agent

- The extension’s `NexusProvider` owns the session, config, indexer, and MCP client. On `newMessage` it calls `runAgentLoop()` with `VsCodeHost`, which emits `AgentEvent` (e.g. `text_delta`, `tool_start`, `tool_end`, `tool_approval_needed`, `done`, `error`). The provider forwards these to the webview via `postMessage({ type: "agentEvent", event })`.
- The webview store (`stores/chat.ts`) handles these events: `text_delta`/`reasoning_delta` update the last assistant message; `tool_approval_needed` sets `awaitingApproval` (VS Code shows the approval dialog via `VsCodeHost.showApprovalDialog()`); `done`/`error` clear `isRunning` and `awaitingApproval`.

## Settings view

- Settings inputs in the webview bind to a local draft; "Apply Settings" sends `saveConfig` to the extension, which merges into config, persists API keys to Secret Storage, writes the rest to `.nexus/nexus.yaml` (keys stripped), and reconnects MCP / reinitializes the indexer when relevant keys change. Do not wire inputs directly to the live extension state; keep a cached draft until Apply.

## Indexer

- The base agent does not require SQLite or a full-text database: `Grep`/`Glob`, bounded file reads, Tree-sitter definitions, and VS Code LSP remain available without an index service. `CodebaseSearch` is exposed only when `indexing.vector` and `vectorDb.enabled` are true and embeddings + Qdrant are healthy. Tracker state is portable JSON; index status is pushed to the webview via **`indexStatus` only**.

## CLI

- Streaming and chat display flow through `nexus-query.ts` into the Ink REPL/message components. Interactive approvals use the TUI ref; headless/print mode denies privileged actions unless the explicitly validated dangerous bypass is active.

## MCP and skills

- MCP servers are configured in config (`mcp.servers`). The extension connects on init and after `saveConfig` when the MCP section changes. Tools from MCP are registered in the agent’s `ToolRegistry`. Skills are loaded from paths in `config.skills` and can be filtered by the classifier when over the threshold.

## Best practices

- When changing agent loop or host behavior, ensure both CLI and extension hosts are updated (approval dialog, runCommand, emit events).
- When adding new `AgentEvent` types, update `packages/vscode/webview-ui/src/stores/chat.ts`, `packages/cli/src/nexus-query.ts`, and the relevant Ink REPL/message projection.
- Avoid memory leaks: indexer and MCP client are disposed in the provider’s `dispose()`; session is not kept in a global.
- Never emit an approval event separately from its dialog. Use the shared approval coordinator so root and concurrent delegated agents cannot overwrite host approval state.
- Privileged plugin mutations must keep `requiresApproval: true`; trusted automatic hooks are the only hook path allowed to execute without a per-call dialog.
