# 2026-03-01 — Debug mode removal + CLI session/scroll alignment

## What changed
- **Debug mode removed** everywhere:
  - Core: `Mode` and `MODES` no longer include `debug`; mode records, config schema, loop budgets, prompts, and parallel spawn mode updated.
  - VS Code: Mode selector and settings (including Debug instructions) removed from webview.
  - CLI: Advanced config form no longer has Debug instructions; modes passed to `saveConfig` are only `agent`, `plan`, `ask`. Advanced form has 8 fields and Save at index 8.
- **CLI alignment with OpenCode-style behavior** (per `sources/explanations/opencode.md`):
  - **Session history in TUI**: `initialMessages` prop added to TUI App; CLI passes `session.messages` so `--continue` and `--session` show full chat history in the viewport.
  - **Scroll on done**: When an agent turn completes (`done` event), chat scroll is reset to bottom so the final response is in view.
  - Existing behavior kept: streaming via `currentStreaming`, viewport with scroll, buildChatLines (messages, tools, subagents, reasoning, errors), retries (429/5xx) in core.

## Why
- User requested removal of debug mode and all its artifacts.
- User requested CLI adoption of OpenCode-related patterns so CLI is stable and supports all Nexus features; OpenCode source is not in repo, so patterns were taken from the description (streaming, chat logic, session, scroll).

## Validation
- `pnpm run build` — passed.
- No linter errors in modified files.
