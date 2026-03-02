# Plan mode: two-phase flow (study → plan → approve/revise/abandon)

## Summary

Plan mode now follows an explicit two-phase flow and, after the plan is ready, offers three actions: **Approve** (execute in agent), **Revise** (send message to update plan), **Abandon** (switch to Ask).

## Changes

### Core

- **prompts (plan mode)**  
  - Phase 1: Thoroughly study the codebase, then produce a detailed step-by-step plan; write only to `.nexus/plans/`.  
  - Phase 2: After `plan_exit`, the user may Approve (run in agent), Revise (send message), or Abandon.  
  - Prompt text updated in `packages/core/src/agent/prompts/components/index.ts` and `packages/core/src/agent/modes.ts` (`MODE_DESCRIPTIONS`).

### CLI TUI

- **State**  
  - `planCompleted: boolean` is set when a tool_end event has `tool === "plan_exit"` and `success === true`.  
  - Cleared when the user sends a message (revise or new task) or when mode is changed (e.g. /plan, /agent, /ask).

- **Plan actions bar**  
  - Shown when `mode === "plan"` and `planCompleted && !isRunning`.  
  - Keys: **[A]** Approve, **[R]** Revise, **[D]** Abandon.  
  - **Approve**: switch mode to agent, send a single user message instructing execution of the plan (e.g. “Execute the plan above…”) and run the agent loop in agent mode.  
  - **Revise**: clear `planCompleted` so the bar hides; user types and presses Enter to send feedback in plan mode.  
  - **Abandon**: switch mode to Ask and clear `planCompleted`.

- **Slash / mode change**  
  - Changing mode via slash (e.g. /agent, /ask, /plan) always sets `planCompleted = false`.

## User flow

1. User selects Plan mode (e.g. `/plan`) and sends a task.
2. Agent runs in plan mode: studies the codebase, writes a plan to `.nexus/plans/`, calls `plan_exit` with a summary.
3. TUI shows “Plan ready” and **[A] Approve / [R] Revise / [D] Abandon**.
4. User chooses:
   - **A**: Mode switches to agent, one “execute the plan” message is sent, agent runs in agent mode and implements the plan.
   - **R**: Bar hides; user types and Enter to revise the plan (next run stays in plan mode).
   - **D**: Mode switches to Ask; plan is not executed.

## Files touched

- `packages/core/src/agent/prompts/components/index.ts` — plan mode block
- `packages/core/src/agent/modes.ts` — MODE_DESCRIPTIONS.plan
- `packages/cli/src/tui/App.tsx` — planCompleted state, tool_end handling, PlanActionsBar, A/R/D handling, clear on submit/slash
