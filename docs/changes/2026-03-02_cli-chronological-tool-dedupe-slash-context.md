# CLI: chronological progress, tool detail, dedupe, slash menu, context with system

## Summary

- Progress (tools, todo) in chronological order: messages first, then tools, then todo/plan.
- Tool lines show file and line/snippet (path, Lfrom-to, command, query, url).
- Dedupe first user message so "привет" doesn’t appear twice.
- Slash menu: one line per command, truncated to cols to avoid overlap.
- Context usage includes system prompt (ask/plan/agent show real total).

## Changes

### 1. buildChatLines order (chronological)
- Order: **messages** (You/NexusCode) → **Tools** (with preview) → **subagents** → **Todo/Plan** → reasoning → streaming → compacting → error.
- Todo/plan block moved to the bottom (above input) and labeled "Todo / Plan".

### 2. Tool preview (file + line/snippet)
- **formatToolPreview(tool)**: builds a short string from `path` (basename), `lineFrom`/`lineTo` (Lfrom-to), `offset`/`limit` (@offset+limit), `command`, `query`, `url`. Used in tool lines: `[status] toolName — preview`.

### 3. Dedupe user message
- Before adding a new user message and calling onMessage, check if the last message is already user with the same content; if so, only clear input and return (no double add, no double send).

### 4. SlashPopup
- One line per command: `▸ /agent — Agent mode (code & tools)` with truncation to `cols - 4` to avoid overlap. Pass `cols` into SlashPopup.

### 5. Context includes system prompt (core)
- **loop.ts**: After building `systemPrompt`, emit `context_usage` with `usedTokens = session.getTokenEstimate() + estimateTokens(systemPrompt)` so the UI shows the real total (including system) in all modes (ask, plan, agent).

## Verification

- `pnpm run build:core` and `pnpm run build:cli` succeed.
