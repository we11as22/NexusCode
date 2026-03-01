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

## Why
- OpenAI-compatible models (including OpenRouter-hosted models) can emit long tool-call chains in ask mode, causing apparent "infinite work" before a final answer.
- The previous CLI viewport prioritized tool logs over conversation content, making responses hard to read in long runs.

## Validation
- `pnpm -C /root/asudakov/projects/NexusCode typecheck` — passed.
- `pnpm -C /root/asudakov/projects/NexusCode build` — passed.
- Manual interactive CLI smoke test (`ask` mode with OpenRouter/openai-compatible model) now consistently returns to idle with visible final response.
