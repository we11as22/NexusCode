# Turn Contract and Surface Parity Implementation Plan

> Implement in small red-green-refactor slices. Do not claim a surface is
> supported until both its execution path and its projection are tested.

**Goal:** Make Nexus demo-ready by aligning prompt, mode, tools, permissions,
runtime events, queueing, code changes, terminal activity, and CLI/VS Code UI
around one truthful per-turn contract.

**Architecture:** Resolve one immutable turn contract in core and use it for
prompt composition, tool materialization, permission enforcement, and emitted
run context. Keep core events authoritative; map them through pure, exhaustive
surface reducers. Preserve existing durable session/change/output stores and
replace only duplicated or contradictory projections.

**Tech stack:** TypeScript, Vitest, React 18, Zustand, Ink, VS Code extension
API, pnpm 10.8.1, Node 24.18.0.

---

## Task 1: Lock the current demo failures with focused tests

**Files:**

- Modify: `packages/core/src/agent/__tests__/modes.test.ts`
- Modify: `packages/core/src/agent/__tests__/mode-execution-boundaries.test.ts`
- Modify: `packages/vscode/webview-ui/src/stores/chat.test.ts`
- Create: `packages/vscode/webview-ui/src/transcript/renderProjection.test.ts`

**Steps:**

1. Add a failing test proving custom `systemPrompt` and
   `customInstructions` reach the generated prompt.
2. Add a failing review-mode test proving the prompt does not advertise Bash.
3. Add a failing synthetic `PlanExit` test proving no plan write means no
   successful exit or completion.
4. Add failing store tests for immutable active mode, next-mode selection, and
   full queued payload retention.
5. Add failing projection tests for stable `Exploring -> Explored` grouping.
6. Run only these tests and record the expected failures.

## Task 2: Introduce the immutable resolved turn contract

**Files:**

- Create: `packages/core/src/agent/turn-contract.ts`
- Create: `packages/core/src/agent/turn-contract.test.ts`
- Modify: `packages/core/src/agent/modes.ts`
- Modify: `packages/core/src/agent/loop.ts`
- Modify: `packages/core/src/types.ts`

**Steps:**

1. Define serializable contract and resolved-mode types.
2. Resolve mode, tool allowlist, permissions, instructions, memory/skill/MCP
   capability flags, and host capability flags once per admitted turn.
3. Pass the contract into prompt generation, provider tool schemas, tool
   execution, compaction continuation, and `run_context` events.
4. Keep compatibility adapters narrow for existing callers.
5. Run focused contract/mode tests and core typecheck.

## Task 3: Make prompts capability-driven and custom modes functional

**Files:**

- Modify: `packages/core/src/agent/modes.ts`
- Modify: `packages/core/src/agent/prompts/components/index.ts`
- Modify: `packages/core/src/agent/prompts/initial-context.ts`
- Modify: `packages/core/src/agent/prompts/components/capabilities.test.ts`
- Modify: `packages/core/src/agent/__tests__/modes.test.ts`

**Steps:**

1. Change prompt builder input from assumed mode capabilities to the exact
   resolved tool/capability manifest.
2. Gate editing, shell, memory, delegation, search, Git, MCP/plugin, and skill
   guidance on actual availability.
3. Insert custom system and mode instructions in stable labelled sections.
4. Correct review and plan claims and retain mode instructions after
   compaction.
5. Run prompt/mode tests, then update snapshots only after semantic review.

## Task 4: Close every PlanExit and privileged-tool bypass

**Files:**

- Modify: `packages/core/src/agent/loop.ts`
- Modify: `packages/core/src/agent/mode-input-policy.ts`
- Modify: relevant PlanExit built-in under `packages/core/src/tools/built-in/`
- Modify: `packages/core/src/agent/__tests__/mode-execution-boundaries.test.ts`
- Modify: `packages/core/src/agent/__tests__/doom-loop-approval.test.ts`

**Steps:**

1. Move plan-write evidence and final mode checks into the common execution
   pipeline after hook/tool-call rewrites.
2. Make `PlanExit` itself fail closed when used outside a valid contract.
3. Mark plan completion only after a successful tool result.
4. Delete the unreachable nested synthetic-exit branch.
5. Cover native, synthetic, rewritten, delegated, failed, and successful
   exits.
6. Run the full core agent test directory.

## Task 5: Define complete queued-turn and active/next-mode state

**Files:**

- Create: `packages/vscode/webview-ui/src/stores/queued-turn.ts`
- Modify: `packages/vscode/webview-ui/src/stores/chat.ts`
- Modify: `packages/vscode/webview-ui/src/stores/chat.test.ts`
- Modify: `packages/vscode/webview-ui/src/components/InputBar.tsx`
- Modify: `packages/vscode/webview-ui/src/components/ModeDropdown.tsx`
- Modify: `packages/vscode/src/provider.ts`
- Modify: `packages/vscode/src/controller.ts`

**Steps:**

1. Replace `{id,text}` queue items with full immutable message payloads.
2. Split `activeRunMode` from `nextMode`.
3. Queue on explicit user intent while running; never remove and reinsert the
   same item as a fake immediate-send action.
4. Admit exactly one queued turn after the current terminal event.
5. Preserve attachments, mode, model/preset, and timestamps.
6. Expose steer only when the active transport advertises safe-boundary
   support; otherwise show queue.
7. Test stop, error, reconnect, remove, send-next, and no-payload-loss paths.

## Task 6: Build one exhaustive webview event reducer

**Files:**

- Create: `packages/vscode/webview-ui/src/stores/agent-event-reducer.ts`
- Create: `packages/vscode/webview-ui/src/stores/agent-event-reducer.test.ts`
- Modify: `packages/vscode/webview-ui/src/stores/chat.ts`
- Modify: `packages/core/src/types.ts` if wire-safe projections need fields
- Modify: `packages/vscode/src/controller.ts`

**Steps:**

1. Derive or mirror the core event union with a compile-time exhaustiveness
   check rather than maintaining an incomplete handwritten subset.
2. Project task, task-tool, team, background task, remote session, plugin hook,
   run-context, terminal, approval, and change events.
3. Preserve unknown future events in bounded diagnostic activity.
4. Prove snapshot replay and live application converge to equal state.
5. Keep private paths out of the wire payload while retaining opaque output
   artifact ids.

## Task 7: Unify transcript projection and exploration lifecycle

**Files:**

- Modify: `packages/vscode/webview-ui/src/transcript/renderProjection.ts`
- Modify: `packages/vscode/webview-ui/src/transcript/helpers.ts`
- Modify: `packages/vscode/webview-ui/src/components/MessageList.tsx`
- Modify: `packages/vscode/webview-ui/src/components/ExploredProgressBlock.tsx`
- Modify: `packages/vscode/webview-ui/src/stores/chat.ts`
- Modify: `packages/vscode/webview-ui/src/transcript/renderProjection.test.ts`

**Steps:**

1. Make the pure projection the single owner of read/search/reasoning groups.
2. Base group running state on contained operation lifecycle.
3. Keep a stable group identity across streaming updates.
4. Render compact counts and expandable operations.
5. Remove dead duplicated helpers/components only after coverage proves the
   imported path is authoritative.
6. Test interleaved text, reasoning, read/search, failures, cancellation, and
   replay.

## Task 8: Render tasks, subagents, teams, and background work truthfully

**Files:**

- Create: `packages/vscode/webview-ui/src/components/TaskActivityCard.tsx`
- Create: `packages/vscode/webview-ui/src/components/TaskActivityCard.test.tsx`
- Modify: `packages/vscode/webview-ui/src/components/MessageList.tsx`
- Modify: `packages/vscode/webview-ui/src/stores/agent-event-reducer.ts`
- Modify: `packages/cli/src/nexus-query.ts`
- Modify: `packages/cli/src/nexus-query-stream.test.ts`

**Steps:**

1. Normalize legacy subagent events and modern task events into one hierarchy.
2. Show title, parent, status, current tool/progress, elapsed time, and outcome.
3. Collapse noisy child activity while retaining expandable detail.
4. Project equivalent concise lifecycle lines in CLI.
5. Test concurrent siblings, resumed tasks, background tasks, failures, and
   cancellation.

## Task 9: Upgrade Bash and durable-output interaction

**Files:**

- Create: `packages/vscode/webview-ui/src/components/TerminalToolCard.tsx`
- Create: `packages/vscode/webview-ui/src/components/TerminalToolCard.test.tsx`
- Modify: `packages/vscode/webview-ui/src/components/MessageList.tsx`
- Modify: `packages/vscode/src/controller.ts`
- Modify: `packages/vscode/src/provider.ts`
- Modify: `packages/cli/src/nexus-query.ts`
- Modify: `packages/core/src/tools/built-in/bash-output.ts`

**Steps:**

1. Preserve command, cwd, task id, status, timing, exit code, preview, and
   output artifact id in the surface projection.
2. Add expand, copy, open/focus terminal, stop background job, and full-output
   retrieval actions when capabilities permit.
3. Bound transcript previews and fetch full output only on explicit action.
4. Give CLI an artifact retrieval hint/action with no private path leakage.
5. Test foreground/background success, failure, cancellation, spill, missing
   terminal shell integration, and reconnect.

## Task 10: Make change review an explicit atomic state machine

**Files:**

- Modify: `packages/core/src/changes/types.ts`
- Modify: `packages/core/src/changes/service.ts`
- Modify: `packages/core/src/changes/service.test.ts`
- Modify: `packages/vscode/webview-ui/src/components/InputContextPanel.tsx`
- Modify: `packages/vscode/webview-ui/src/components/MessageList.tsx`
- Modify: `packages/vscode/src/controller.ts`
- Modify: `packages/cli/src/change-review.ts`
- Modify: `packages/cli/src/change-review.test.ts`

**Steps:**

1. Expose the existing durable change-set stages through an explicit
   surface-safe projection.
2. Use pre-apply `Apply/Reject` and post-apply `Keep/Revert` labels.
3. Render multi-file patches as one atomic decision with per-file previews.
4. Ensure `showDiff` uses the owned before/after content, not a plain file
   open fallback.
5. Disable controls during apply/revert and recover state on reconnect.
6. Remove unused alternate change component after confirming no imports.
7. Test stale CAS, partial host failure compensation, grouped actions, undo,
   keep, and diff behavior.

## Task 11: Finish extension UI/UX, accessibility, and decomposition

**Files:**

- Modify: `packages/vscode/webview-ui/src/index.css`
- Modify: `packages/vscode/webview-ui/src/App.tsx`
- Modify: `packages/vscode/webview-ui/src/components/InputBar.tsx`
- Modify: `packages/vscode/webview-ui/src/components/ModeDropdown.tsx`
- Modify: affected component tests and styles

**Steps:**

1. Remove forced dark color scheme and replace hard-coded colors with VS Code
   theme variables.
2. Replace decorative emoji controls with codicons/text plus accessible names.
3. Add visible focus, keyboard actions, reduced-motion support, and narrow
   layout behavior.
4. Split only stable stateful sections out of the giant `App`/message
   components; avoid a risky visual rewrite.
5. Render and inspect light, dark, high-contrast, and narrow viewport states
   using local extension/webview fixtures.

## Task 12: Validate installation and first-run safety

**Files:**

- Modify as failures require:
  - `scripts/install-nexus-cli.sh`
  - `packages/cli/src/entrypoints/cli.tsx`
  - config/secrets helpers under `packages/core/src/config/`
- Add focused regression tests beside the changed code.

**Steps:**

1. From a shell initially resolving Node 20, run the installer and verify it
   selects the pinned Node 24 runtime or prints an actionable installation
   path.
2. Run CLI with an isolated temporary HOME/XDG config and prove
   `~/.nexus/config.json`/YAML parent creation cannot throw `ENOENT`.
3. Exercise help, first-run configuration, one mocked chat turn, mode
   selection, approval denial, queueing, and clean exit.
4. Build/package the VSIX and smoke extension activation in an isolated
   extension/test environment without real provider calls.

## Task 13: Full verification, comparison update, and checkpoint

**Files:**

- Modify: `docs/engineering/reference-comparison.md`
- Create: `docs/superpowers/checkpoints/2026-07-28-demo-ready-turn-and-ui.md`

**Steps:**

1. Run with repository-pinned Node `24.18.0`:
   - `corepack pnpm typecheck`
   - `corepack pnpm test`
   - `corepack pnpm build`
   - `corepack pnpm test:runtime`
   - `corepack pnpm package:vscode`
2. Run focused install/CLI/VS Code smoke tests using temporary directories.
3. Run `git diff --check`, inspect all changed files, and confirm no secrets,
   generated junk, or unrelated user changes.
4. Update the comparison table with exact implemented behavior and honest
   remaining platform limits.
5. Commit coherent slices, then push `main` only after all required evidence
   passes.
