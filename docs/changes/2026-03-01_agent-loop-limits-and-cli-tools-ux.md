# 2026-03-01 — Agent loop limits and CLI tools UX

## What changed
- **Tool and iteration limits (OpenCode-style):** Increased default budgets so “study codebase” and multi-file tasks can complete:
  - Tool call budget: ask 80, plan 80, agent 200 (was 24/40/120).
  - Max iterations: ask 24, plan 24, agent 48 (was 10/16/32).
- **Final-answer turn fix:** When the tool budget is exceeded we set `forceFinalAnswerNext` and allow one more iteration; previously the loop could exit on `loopIterations > maxIterations` before that turn ran. The guard now breaks only when `!forceFinalAnswerNext`; when forcing final answer we allow one extra iteration so the model can send a text-only response.
- **`isFinalIteration`:** Now true when `forceFinalAnswerNext || loopIterations >= maxIterations` so the “extra” final turn is correctly treated as final (tools disabled, final-answer prompt block added).
- **Config overrides:** Added optional `agentLoop` in config (and `NexusConfig`):
  - `agentLoop.toolCallBudget`: optional `{ ask?, plan?, agent? }` to override default tool budgets.
  - `agentLoop.maxIterations`: optional `{ ask?, plan?, agent? }` to override default max iterations.
- **CLI TUI tools section:** Group consecutive same-tool entries in the chat viewport so that e.g. 12× `read_file` is shown as “12× read_file” (with optional preview) instead of 12 separate lines. Keeps last 80 tools for grouping; display remains compact and readable.

## Why
- Users hit the previous limits on “study the codebase” flows and received no final answer because the loop stopped as soon as the budget was exceeded, without a dedicated final-answer turn.
- Aligning with OpenCode-style generous limits and ensuring the forced final-answer iteration always runs improves completion and UX.
- Config overrides allow tuning limits per project without code changes.
- Grouping repeated tools in the CLI reduces noise and matches a “full OpenCode-style” TUI where chat is built from messages, tools, subagents, reasoning, and scroll.

## Validation
- `pnpm build` — passed.
- No new linter errors in `packages/core` or `packages/cli`.
