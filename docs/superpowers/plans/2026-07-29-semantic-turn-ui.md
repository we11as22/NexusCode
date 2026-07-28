# Semantic Turn UI and Smooth Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the VS Code transcript match the supplied Cursor interaction model, make CLI semantically equivalent, and remove streaming jitter and duplicate activity without weakening event durability.

**Architecture:** Keep core/server events complete and ordered. Add durable turn timing, project raw events/messages into stable semantic turn blocks, and batch only at the UI delivery boundary. A completed turn collapses all technical work between its user request and final answer under `Worked for Ns`; the final answer remains visible.

**Tech Stack:** TypeScript, Vitest, React 18, Zustand, react-virtuoso, VS Code webviews, requestAnimationFrame batching, Ink.

## Global Constraints

- The screenshots define VS Code extension behavior, not literal CLI layout.
- `Explored` has independent files, lists, and searches counters.
- Do not hide approvals, errors, or live work while a run is active.
- Preserve chronological detail when a completed work block is expanded.
- Never coalesce deltas across message id, reasoning id, sequence boundary, or terminal event.
- Durable event storage stays lossless; smoothing is a projection concern.
- Run every task red-green-refactor.

---

## Task 1: Persist one exact turn duration

**Files:**

- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/agent/loop.ts`
- Modify: `packages/core/src/agent/__tests__/loop.test.ts` or the nearest loop lifecycle test
- Modify: `packages/core/src/session/storage.test.ts`
- Modify: `packages/core/src/protocol/v2.ts`

- [ ] Add a failing lifecycle test that supplies a deterministic clock and expects `done.durationMs`.
- [ ] Add optional `durationMs` to `SessionMessage` and `AgentEvent.done`.
- [ ] Capture one start timestamp when a turn is admitted; persist the elapsed value on the final assistant message and emit the same value on `done`.
- [ ] Keep old events and sessions valid when duration is absent.
- [ ] Run focused core/protocol/storage tests.

## Task 2: Define stable user-turn boundaries in the webview projection

**Files:**

- Modify: `packages/vscode/webview-ui/src/transcript/renderProjection.test.ts`
- Modify: `packages/vscode/webview-ui/src/transcript/renderProjection.ts`
- Modify: `packages/vscode/webview-ui/src/components/MessageList.tsx`
- Create: `packages/vscode/webview-ui/src/components/CompletedWorkBlock.tsx`
- Modify: `packages/vscode/webview-ui/src/index.css`

- [ ] Add failing tests with user → multiple assistant/tool messages → final answer and two consecutive turns.
- [ ] Introduce a `completed_work` render item keyed by the user/turn identity.
- [ ] Put reasoning, exploration, Bash, tool results, approvals, subagent/task cards, and intermediate status inside the completed block.
- [ ] Keep the canonical final assistant text outside the block.
- [ ] Keep live-run items expanded and visible; only create `completed_work` after a matching completion with duration.
- [ ] Render compact `Worked for 53s` with an accessible disclosure button and full chronological children.
- [ ] Run projection/component tests.

## Task 3: Make exploration counts and deduplication exact

**Files:**

- Modify: `packages/vscode/webview-ui/src/components/ExploredProgressBlock.tsx`
- Modify: `packages/vscode/webview-ui/src/transcript/renderProjection.ts`
- Modify: `packages/vscode/webview-ui/src/transcript/renderProjection.test.ts`

- [ ] Add failing tests for repeated reads of one file, list-directory calls, grep/search calls, terminal polls, failures, and mixed waves.
- [ ] Count unique files, listing operations, and search operations independently.
- [ ] Render combinations such as `Explored 3 files, 2 searches` without pretending searches are files.
- [ ] Treat terminal read/wait polls and glue reasoning as details of the current wave, not peer transcript rows.
- [ ] Preserve separate Bash/write/error cards and a stable exploration key from running to complete.
- [ ] Run the focused projection tests.

## Task 4: Batch VS Code stream deltas without losing order

**Files:**

- Modify: `packages/vscode/webview-ui/src/bridge/message-buffer.ts`
- Create: `packages/vscode/webview-ui/src/bridge/message-buffer.test.ts`
- Modify: `packages/vscode/webview-ui/src/stores/chat.test.ts`
- Modify: `packages/vscode/src/provider-buffering.test.ts`
- Modify: `packages/vscode/src/provider.ts`
- Modify: `packages/vscode/src/controller.ts`

- [ ] Add failing fake-animation-frame tests proving adjacent compatible deltas coalesce, incompatible ids do not, and boundary events flush prior deltas.
- [ ] Buffer adjacent `text_delta` by message id and `reasoning_delta` by message/reasoning id within one frame.
- [ ] Preserve sequence order and exact concatenated text.
- [ ] Flush before state snapshots, tool lifecycle, approval, error, done, disposal, reconnect, and replay handoff.
- [ ] Keep full state sync disabled for each text/reasoning delta.
- [ ] Prove snapshot/event reconciliation produces one copy of streamed text.
- [ ] Run buffer, controller, remote-turn, and store tests.

## Task 5: Smooth CLI streaming and preserve the final partial line

**Files:**

- Modify: `packages/cli/src/nexus-message-projection.test.ts`
- Modify: `packages/cli/src/nexus-message-projection.ts`
- Modify: `packages/cli/src/nexus-query.ts`
- Modify: `packages/cli/src/screens/REPL.tsx`

- [ ] Add failing tests for long single-line output, interleaved reasoning/text, tool boundary, error, abort, and done.
- [ ] Keep the authoritative full draft separate from the published Ink preview.
- [ ] Coalesce adjacent compatible events before React state updates.
- [ ] Publish stable complete lines during streaming and force-publish the remaining partial line at every terminal boundary.
- [ ] Ensure private reasoning respects the display setting and never leaks through the final flush.
- [ ] Run CLI projection and query-stream tests.

## Task 6: Make code-change review compact and safe

**Files:**

- Modify: `packages/vscode/webview-ui/src/components/InputContextPanel.tsx`
- Create: `packages/vscode/webview-ui/src/components/InputContextPanel.test.tsx`
- Modify: `packages/vscode/webview-ui/src/index.css`
- Modify: `packages/vscode/src/controller.ts`
- Modify: `packages/vscode/src/webview-protocol-types.ts`

- [ ] Add failing tests for one-file and multi-file unresolved Nexus-owned change sets.
- [ ] Default the strip to collapsed and label actions `Undo`, `Keep`, and `Review`.
- [ ] Make one-file Review open its owned before/after diff immediately; make multi-file Review expand the list.
- [ ] Disable actions while a mutation is pending and retain atomic change-set semantics.
- [ ] Exclude accepted, reverted, stale, and unrelated Git changes.
- [ ] Run component/controller/change-service tests.

## Task 7: Validate extension and CLI user flows against sources

- [ ] Re-read the exact streaming/rendering paths in Codex, OpenClaude, Kilo, Kimi, Qwen, and MiMo and record any intentional Nexus adaptations in the comparison document.
- [ ] Run webview projection, store, buffer, controller, remote-turn, and CLI suites.
- [ ] Run `pnpm typecheck`, `pnpm test`, and `pnpm build`.
- [ ] Package the VSIX and install it into the available VS Code only after successful non-GUI checks.
- [ ] Open the safe workspace `/Users/mac/Projects/nexus/test`.
- [ ] Validate: read/search exploration, Bash output, file create/edit diff, single and multi-file Review, Keep, Undo, subagent lifecycle, queued message, stop/error, reconnect, and completed `Worked for` collapse.
- [ ] Inspect CPU/memory and extension-host logs during a synthetic high-delta stream; confirm no per-delta full-state serialization.
- [ ] Run a minimal CLI scenario covering streaming, search, Bash, edit review, and completion.
- [ ] Run `git diff --check` and preserve test-workspace changes outside the product repository.
