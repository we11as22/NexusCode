# Turn Contract and Surface Parity Design

**Date:** 2026-07-28

**Status:** Approved for implementation

**Scope:** core agent runtime, prompts and modes, tool/permission enforcement,
CLI/VS Code projections, queued input, task/subagent/background activity,
terminal output, code-change review, and extension UX.

## Goal

Make every Nexus turn execute and render from one truthful contract. A mode
shown to the user must be the mode that built the prompt, selected the tools,
enforced permissions, emitted events, and owned the resulting changes. CLI,
server, and VS Code may present that contract differently, but may not invent
different semantics.

This design is based on executable source behavior rather than documentation
claims:

- Codex supplies immutable per-turn context, tool-router alignment, explicit
  input admission, and lifecycle discipline.
- OpenClaude supplies capability-aware prompt composition, plan-mode
  continuity, compact read/search activity, tasks, and background work.
- Kilo supplies resolved agent profiles, typed service boundaries, and
  productized extension/diff behavior.
- Kimi and Qwen supply exact queued-turn identity, conservative state
  transitions, tool restriction, and reconnect semantics.
- Roo and Cline supply useful VS Code task, terminal, diff, and checkpoint
  interaction patterns.

Nexus keeps its shared TypeScript core and does not copy parallel legacy
runtimes or provider-specific behavior.

## 1. One immutable turn contract

At admission, Nexus resolves an immutable `TurnContract` containing:

- turn/run/session identity;
- requested and resolved mode;
- resolved model/provider profile;
- exact enabled tool names and schemas;
- effective permission policy and workspace trust;
- active instructions, rules, memory, skills, MCP/plugin capabilities;
- host capabilities and surface metadata;
- compaction and token budgets.

The active run keeps this snapshot until it ends. Configuration, MCP refresh,
skill discovery, or a UI mode selection may affect the next turn, never
silently mutate the active turn.

The contract is the only input to prompt composition, model tool exposure, and
permission enforcement. The prompt therefore cannot describe a tool that the
model did not receive, and customization cannot grant a capability excluded by
the resolved policy.

## 2. Mode semantics

Built-in and custom modes resolve through one profile:

- `agent`: full coding workflow within permission policy;
- `plan`: investigation and plan-file mutation only, then explicit `PlanExit`;
- `ask`: explanation and read-only inspection;
- `debug`: evidence-first diagnosis with mutations only when its policy allows;
- `review`: side-effect-free review, including Git inspection but no shell
  execution;
- custom modes: inherit a declared base mode, then add instructions and narrow
  tools/permissions.

`systemPrompt` and `customInstructions` are real inputs, not stored decoration.
They are inserted in a stable, labelled position and are preserved after
compaction. They may narrow behavior but cannot re-enable a denied tool.

The extension exposes one selected mode and disables mode switching while a
turn is active, matching Codex's fail-closed interaction. A queued message
stores its own mode snapshot together with its full payload, matching the
turn-bound queue behavior in Kilo and Kimi. Nexus therefore does not need a
second global `nextMode` state machine.

## 3. Capability-driven prompt composition

The system prompt is composed from typed sections with explicit predicates.
Examples:

- editing guidance appears only when a mutation tool is enabled;
- shell guidance appears only when a shell tool is enabled;
- memory instructions appear only when memory tools/context are available;
- task/subagent instructions appear only when the runtime exposes them;
- MCP, skill, plugin, Git, and code-search text describes only resolved
  capabilities.

The final prompt contains a compact generated capability manifest derived from
the same tool registry sent to the model. Mode instructions are re-projected
after compaction. Review mode never claims Bash access. Plan mode clearly
describes its narrow writable plan path and does not imply unrelated mutation
rights.

## 4. PlanExit and privileged execution invariants

The plan-exit gate belongs to the execution pipeline, not only to the native
provider-call branch. Every invocation path—native, synthetic recovery,
plugin/hook rewrite, and delegated execution—must pass the same checks after
all rewrites:

1. validate the final tool call;
2. resolve the active turn contract;
3. enforce mode/tool policy;
4. enforce plan-file evidence for `PlanExit`;
5. run permission approval if required;
6. execute and emit one authoritative result.

Completion is recorded only after a successful `PlanExit` result. A failed or
blocked synthetic exit may not mark the plan complete. Tests must cover the
forced synthetic path and calls rewritten by hooks.

## 5. Input admission, queueing, and steering

A queued item is a complete `QueuedTurn`, not a text string:

- stable client-owned id;
- text and attachments;
- selected mode and model/preset;
- relevant composer metadata;
- enqueue timestamp and delivery intent.

Submitting while a run is active has explicit semantics:

- queue submits an immutable next turn;
- steer is offered only when the active backend supports safe-boundary
  delivery;
- rejected or interrupted steering is returned to the queue without losing
  payload;
- exactly one queued turn is admitted after terminal completion;
- stop never discards queued work.

Local CLI/extension and remote sessions share the same admission state model.
The UI must not label a local no-op as steering.

## 6. Typed runtime events and projections

`AgentEvent` in core is authoritative. Each surface uses an exhaustive reducer
or explicit projection for:

- text/reasoning and tool lifecycle;
- approvals;
- task, subagent, team, and background-task lifecycle;
- run context and active mode;
- remote session/reconnect state;
- plugin hooks;
- code-change proposals and applied/reverted changes;
- terminal/output artifacts;
- terminal completion/error/cancellation.

Unknown future events are retained as diagnostic activity instead of silently
vanishing. Reducers are pure and independently tested. Snapshot replay and
live streaming must produce the same UI state.

## 7. Transcript and exploration UX

Read/search/reasoning activity is projected into a stable exploration group:

- while relevant work is in progress, label it `Exploring`;
- after all contained operations terminate, label it `Explored`;
- preserve a stable group key while streaming;
- show compact counts and allow expansion to individual operations;
- never infer running state solely from global run state when the group itself
  is terminal.

One render-projection implementation owns grouping. Duplicate legacy
projection helpers and unused components are removed after tests lock the
behavior.

## 8. Terminal and large-output UX

Bash/PowerShell activity is a first-class card containing command, cwd,
foreground/background state, live status, elapsed time, exit code, bounded
preview, and actions appropriate to the state:

- copy command/output;
- expand/collapse;
- open or focus the integrated terminal when available;
- stop a live background task;
- retrieve the full durable output artifact when output was spilled.

The wire projection preserves the opaque artifact id without leaking private
paths. CLI presents equivalent status and retrieval information in terminal
form.

## 9. Code-change lifecycle

All mutation tools use one explicit change-set state machine:

`proposed -> approved -> applying -> applied -> kept`

with alternative terminal paths:

`proposed -> rejected`, `applied -> reverting -> reverted`, or `failed`.

Multi-file patches are atomic and rendered as one grouped decision. Per-file
rows are previews, not misleading independent approval controls. Labels match
the actual stage:

- before apply: `Apply` / `Reject`;
- after apply: `Keep` / `Revert`;
- grouped calls: `Apply all files` / `Reject patch`, then `Keep patch` /
  `Revert patch`.

Diff actions always open a real before/after comparison for the owned change
set. Snapshot/reconnect must retain ownership and pending actions.

## 10. Extension presentation

The extension uses VS Code theme variables and codicons, supports light and
dark themes, keyboard navigation, visible focus, screen-reader labels, narrow
sidebars, and reduced motion. It must not force a dark color scheme.

The composer exposes:

- active/next mode truthfully;
- send, queue, stop, and supported steer actions;
- attachments and mode retained in queued cards;
- queue reorder/remove/send-next controls;
- pending approval/change summaries without duplicate conflicting controls.

Task/subagent/background cards show state, hierarchy, current activity,
duration, and terminal outcome without flooding the transcript.

## 11. Architecture boundaries

The work is evolutionary, not a rewrite:

- `packages/core` owns turn resolution and execution invariants;
- shared protocol/types own events and queued-turn payloads;
- surface adapters map host capabilities only;
- pure transcript/activity/change reducers live outside giant React
  components;
- React components render state and dispatch intents;
- controllers perform VS Code-specific effects.

Dead duplicates are removed only after the authoritative path is covered by
tests. No new classifier is added for MCP or skills; exact/deterministic
discovery remains easier to audit.

## 12. Verification and demo gate

Required evidence before completion:

- focused tests for every fixed invariant, written red first;
- core, state, CLI, server, VS Code, and webview typechecks/tests;
- production monorepo build with Node `24.18.0`;
- CLI installation from a shell initially pointing at Node 20;
- clean-home first-run smoke test proving config directories are created;
- VSIX packaging and extension activation smoke test;
- replay/snapshot equivalence for UI events;
- light/dark and narrow-width rendered UI inspection where automation permits;
- `git diff --check` and review of the final committed diff.

Real-provider or destructive workspace tests remain minimal. Tests use the
repository fixture area and temporary homes/workspaces, never the user's real
project data.
