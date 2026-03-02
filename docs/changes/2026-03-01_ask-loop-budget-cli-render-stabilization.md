# 2026-03-01 — Ask loop budget + CLI render stabilization

## What changed
- Added a hard per-run tool-call budget in agent loop with mode-specific limits:
  - `ask`: 24
  - `plan`: 40
  - `agent`/`debug`: 120
- When the budget is reached, Nexus now forces a final no-tools answer on the next iteration instead of continuing read/search waves indefinitely.
- Improved CLI TUI chat rendering:
  - reduced noisy tool history in viewport (show only compact "Working: ..." for active tools),
  - padded status/footer lines to terminal width to avoid visual artifacts from partial redraws.
- Added CLI chat navigation improvements:
  - chat history scroll now works with `↑/↓` when input is empty (plus existing `PgUp/PgDn`, `Ctrl+U/D`),
  - tool stream is visible in the chat viewport as a recent timeline (`running/completed/error`).
- Hardened VS Code provider startup path:
  - `newMessage` now waits for `ensureInitialized()` first,
  - if initialization is still unavailable, extension emits an explicit error event instead of silently staying in `Running`.
- Hardened index refresh filtering:
  - realtime `refreshFileNow` now indexes only supported code/markdown extensions and ignores files outside project root,
  - refresh path keeps the same size cap as full scan (>1MB skipped), preventing accidental indexing of non-code artifacts.
- Fixed VS Code webview streaming state assembly:
  - assistant message placeholders are now created/upserted by `messageId` for `text_delta`, `tool_start`, and `reasoning_delta`,
  - tool/progress cards are no longer dropped when tool events arrive before first text token.
- Fixed VS Code startup/run deadlock path:
  - `ensureInitialized()` no longer blocks on MCP connection and index bootstrap,
  - MCP/index init now runs in background with explicit error events,
  - chat request handling is no longer held by slow/broken MCP startup.
- Fixed VS Code initialization race:
  - concurrent `ensureInitialized()` calls are now synchronized through `initPromise`,
  - `newMessage` can no longer run against partially initialized `session/config`.
- Improved webview event delivery reliability:
  - extension now posts updates to both sidebar view and panel webview targets (when both exist),
  - prevents state/event loss when user switches between sidebar and panel.
- Added git refresh safety timeout:
  - per-command timeout in pre-run git delta refresh avoids long hangs before agent loop starts.
- Fixed stale indexing UI state in webview:
  - removed optimistic `indexing 0/0` override on `reindex/clearIndex`,
  - index status is now driven only by real backend indexer events.
- Expanded CLI chat navigation parity:
  - added `Ctrl+B/Ctrl+F` half-page scrolling in chat,
  - kept `↑/↓`, `PgUp/PgDn`, `Ctrl+U/D` behavior and refreshed footer hints.

## Why
- OpenAI-compatible models (including OpenRouter-hosted models) can emit long tool-call chains in ask mode, causing apparent "infinite work" before a final answer.
- The previous CLI viewport prioritized tool logs over conversation content, making responses hard to read in long runs.

## Validation
- `pnpm -C /root/asudakov/projects/NexusCode typecheck` — passed.
- `pnpm -C /root/asudakov/projects/NexusCode build` — passed.
- `pnpm -C /root/asudakov/projects/NexusCode/packages/vscode package` — passed, VSIX rebuilt.
- Manual interactive CLI smoke test (`ask` mode with OpenRouter/openai-compatible model) now consistently returns to idle with visible final response.
- Manual interactive CLI smoke in TTY confirms live streaming text and clean transition from `Running` to idle input without process drop.
