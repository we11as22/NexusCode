# 2026-03-01 — Extension UI: Cline-style progress, Server URL, run guide

## What changed

### Extension UI (Cline / progress-display style)
- **Sessions loading**: When opening the Sessions tab or on getState, the extension now sends `sessionListLoading: true` before fetching the session list and `sessionListLoading: false` when done. The webview shows a **Loading...** line with animated dots (three dots, pulse animation) while sessions are loading.
- **Thought block**: The reasoning block is styled as a clear card with border and **"Thought for Xs"** header (or "Thinking…") and a short preview of the reasoning text, matching the conversational progress style from the reference screenshot.
- **Tool output diffs**: When a tool’s output looks like a unified diff (lines starting with `+` or `-`), it is rendered with **green** for added lines and **red** for removed lines (diff-style), instead of plain monospace.
- **Server URL in Settings**: In **Settings → Agent Settings**, a new **NexusCode Server** section at the top allows setting **Server URL** (e.g. `http://127.0.0.1:4097`). The value is persisted via `nexuscode.serverUrl` (VS Code workspace/global config). When set, the extension uses the server for sessions and agent runs; when empty, it runs in-process.

### Provider
- **setServerUrl** webview message: Updates `nexuscode.serverUrl` in VS Code configuration (global) and triggers a state update so the webview sees the new value.
- **serverUrl in state**: `postStateUpdate()` includes `serverUrl` from `vscode.workspace.getConfiguration("nexuscode").get("serverUrl")` so the Settings view can display and edit it.

### Documentation
- **README.md**: Added **NexusCode Server (optional)** section: how to start the server (`pnpm serve`), set Server URL in the extension, use CLI with `--server`, and the recommended run order (start server → set URL → use extension/CLI). Bullet about optional server and Cline-style UI in the feature list.
- **docs/run.md**: New **run guide** (RU): one-time build, default mode (no server), server mode (start server, extension Settings → Server URL, CLI `--server`), F5 development, and a short command reference.
- **ARCHITECTURE.md**: Data Flow updated to describe server vs in-process paths and that extension/CLI can list/switch sessions and load messages in pages when using the server.

## Why
- User asked for the extension to be aligned with Cline and the reference image: progress display (Thought for Xs, Loading...), clear styling, diff-style tool output.
- User asked for full integration with the NexusCode server and DB, and for documentation/run guides to be updated.

## References
- Extension: `packages/vscode/webview-ui/src/App.tsx` (SessionsView loading, Settings Server URL), `ThoughtBlock.tsx`, `ToolCallCard.tsx`, `index.css` (loading dots), `stores/chat.ts` (sessionsLoading, serverUrl), `types/messages.ts` (sessionListLoading, serverUrl in state).
- Provider: `packages/vscode/src/provider.ts` (sendSessionList with sessionListLoading, setServerUrl handler, serverUrl in postStateUpdate).
