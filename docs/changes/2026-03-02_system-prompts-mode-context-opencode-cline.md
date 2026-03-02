# System prompts and mode context (OpenCode/Kilo/Cline alignment)

## Summary

- **Current mode** is now explicit in the Environment block (`<env>`) on every turn, so the model always sees "Current mode: AGENT | PLAN | ASK" with a one-line reminder. This matches Cline (mode in environment_details) and avoids ambiguity when switching modes.
- **ASK mode** has a full system prompt block: identity (read-only technical assistant), strict constraints (no edit/execute/browser/spawn_agent), and explicit "suggest switching to agent mode for implementation" (Kilo ask.txt style).
- **PLAN mode** block was tightened: explicit "READ-ONLY planning phase" and "MUST NOT modify source code or run shell commands", with only `.nexus/plans/*` writable (OpenCode plan reminder style).
- **AGENT mode** block unchanged in substance; Environment line clarifies full access and attempt_completion.

## Changes

### 1. Environment block: `Current mode: ...`

- **File:** `packages/core/src/agent/prompts/components/index.ts`
- **Function:** `buildSystemInfoBlock` now pushes `Current mode: ${getCurrentModeLabel(ctx.mode)}` right after the Context line.
- **Helper:** `getCurrentModeLabel(mode)` returns:
  - **AGENT:** `"AGENT (full access: read, write, execute, search, MCP). Complete tasks end-to-end; use attempt_completion when done."`
  - **PLAN:** `"PLAN (read-only planning). You may ONLY write to .nexus/plans/*.md or .txt. Do not modify source code or run commands. Use plan_exit when the plan is ready."`
  - **ASK:** `"ASK (read-only). Do NOT modify files or run commands. Answer questions and explain code; suggest switching to agent mode for implementation."`

### 2. Mode blocks in `getModeBlock(mode)`

- **ASK:** Rewritten to match Kilo's ask.txt:
  - "You are a knowledgeable technical assistant..." (read-only).
  - **Strict constraints:** MUST NOT edit/create/delete files; MUST NOT run shell commands; MUST NOT use browser_action or spawn_agent; if implementation is needed, tell user to switch to agent mode.
  - **What to do:** answer thoroughly, analyze code, use Mermaid, support with code evidence, always end with text summary after tools, recommend agent mode for implementation requests.
- **PLAN:** Added explicit "You are in READ-ONLY planning phase" and "You MUST NOT modify source code or run shell commands"; clarified that only `.nexus/plans/*` is writable; kept Phase 2 (after plan_exit) and "brainstorming session" note.
- **AGENT:** Unchanged except consistency with the rest.

## References

- Cline: `environment_details` with "# Current Mode" + "PLAN MODE" or "ACT MODE"; ACT_VS_PLAN section in system prompt.
- OpenCode: plan reminder (plan.txt) as synthetic user part; build-switch.txt on plan→build.
- KiloCode: `agent.prompt` for ask (ask.txt), soul + provider + environment; plan reminder and code-switch as synthetic parts.
- NexusCode does not use synthetic user parts for mode switch; mode is fixed per run and is now clearly stated in the system Environment block and in the mode-specific block.
