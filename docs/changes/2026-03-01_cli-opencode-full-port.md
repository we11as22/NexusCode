# 2026-03-01 — CLI: full OpenCode logic port (sources/opencode)

## What changed
- **Event batching (OpenCode-style):** CLI TUI now batches agent events every 16ms before applying state updates. Events are queued and flushed either on a 16ms timer or immediately on `done`/`error`. Reduces re-renders during streaming and matches OpenCode’s SDK event batching.
- **Scroll behavior:** “Jump to latest” when user has scrolled up: hint “↓ New content — Ctrl+G or End to jump to latest” when `scrollLines > 0` and agent is running. Shortcuts: **Ctrl+G** and **End** scroll to bottom (latest). Footer updated to show Ctrl+G/End(latest).
- **Slash commands aligned with OpenCode:**  
  - `/new` — alias for “clear chat” (like OpenCode /new).  
  - `/thinking` — toggle visibility of reasoning/thinking block in chat.  
  - `/details` — toggle tool execution details (show/hide preview path/query in tool lines).
- **State:** Added `showThinking` and `showToolDetails` to App state (default true). Used in `buildChatLines` for reasoning block and tool line preview.

## Why
- User requested a full copy of OpenCode’s logic and behavior, adapted to NexusCode’s agent (runAgentLoop, AgentEvent, Session, modes, index). OpenCode source lives in `sources/opencode`; it uses Solid.js + @opentui, so the port is logic and UX, not literal code.
- Batching improves TUI responsiveness during long streams. Scroll and slash commands bring CLI behavior in line with OpenCode’s TUI (session view, jump to latest, /thinking, /details).

## Validation
- `pnpm build` — passed.
- No new linter errors in `packages/cli`.

## Notes
- Session view structure (messages + parts as in OpenCode’s scrollbox with UserMessage/AssistantMessage and part components) is already reflected in our `buildChatLines` (messages, tools, subagents, reasoning, streaming). A full “part-based” model would require a larger refactor of session state and is not done here.
- OpenCode’s worker/thread architecture (separate process + RPC/SSE) is not ported; NexusCode runs the agent in-process and pushes events via the same event stream.
