# Cursor-like Change Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NexusCode’s extension and CLI render exact, durable, compact Cursor-like file changes and a correctly spaced Thought/Explored/Worked timeline across live streaming and session reload.

**Architecture:** Persist a bounded canonical diff projection on each mutating `ToolPart`, derive both session state and live `tool_end` events through one core helper, and render only proven structured changes. Keep full review/revert authority in the existing ChangeSet service while using the bounded projection for transcript UI.

**Tech Stack:** TypeScript, Zod, Vitest, React, Zustand, Ink, native bounded chat scrolling, VS Code webview.

## Global Constraints

- Test filesystem mutations only under `/Users/mac/Projects/nexus/test`.
- Do not run heavy indexing, repository-wide stress tests, or unbounded GUI automation.
- Do not persist full file contents or private filesystem spill paths in transcript/UI state.
- Preserve compatibility with old JSONL sessions and protocol v2 clients.
- Use exact source-derived behavior from Codex, OpenClaude, Kilo, Roo and Kimi; do not add heuristic classifiers.
- Every production behavior change follows red-green-refactor.

---

### Task 1: Canonical durable file-change projection

**Files:**
- Create: `packages/core/src/agent/file-change-projection.ts`
- Create: `packages/core/src/agent/file-change-projection.test.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/agent/loop.ts`
- Modify: `packages/core/src/agent/loop.test.ts`

**Interfaces:**
- Produces: `ToolDiffLine`, `AppliedReplacement` and optional fields on `ToolPart`.
- Produces: `projectFileChangeToolResult(toolName, input, metadata): Partial<ToolPart>`.
- Consumes: existing `extractWriteTargetPath`, `normalizedAppliedReplacementsFromMetadata` behavior, moved or wrapped without changing validation semantics.

- [ ] **Step 1: Write a failing unit test for canonical projection**

Create literal fixtures for `Write` and `Edit`. Assert that `path`, exact
`diffStats`, bounded `diffHunks` and normalized `appliedReplacements` are
returned and malformed lines are discarded.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/core test -- file-change-projection.test.ts
```

Expected: failure because `projectFileChangeToolResult` does not exist.

- [ ] **Step 3: Add the durable types and minimal pure projector**

Add only bounded structured fields; do not add `writtenContent` to `ToolPart`.
Validate `type`, non-negative safe `lineNum`, string `line`, and non-empty
replacement arrays.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2 and require exit code 0.

- [ ] **Step 5: Write failing integration tests for native and textual loops**

For both paths, execute a small controlled `Write`/`Edit` result and assert the
stored session message contains the same diff projection as the emitted
`tool_end`.

- [ ] **Step 6: Run the loop tests and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/core test -- loop.test.ts
```

Expected: stored `ToolPart.diffHunks`/`appliedReplacements` are missing.

- [ ] **Step 7: Replace duplicated loop mapping with the projector**

Use the same object for `session.updateToolPart` and event projection in both
native and textual paths. Keep event-only `writtenContent` out of the durable
object.

- [ ] **Step 8: Run core focused tests and verify GREEN**

Run both focused test files and require zero failures.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/agent/file-change-projection.ts packages/core/src/agent/file-change-projection.test.ts packages/core/src/types.ts packages/core/src/agent/loop.ts packages/core/src/agent/loop.test.ts
git commit -m "fix: persist canonical file change previews"
```

### Task 2: Session, protocol, compaction and projection invariants

**Files:**
- Modify: `packages/core/src/session/index.test.ts`
- Modify: `packages/core/src/session/compaction.test.ts`
- Modify: `packages/core/src/protocol/v2.test.ts`
- Modify: `packages/vscode/src/webview-projection.test.ts`
- Modify: `packages/vscode/src/controller.test.ts`

**Interfaces:**
- Consumes: `ToolPart.diffHunks` and `ToolPart.appliedReplacements`.
- Produces: evidence that stateUpdate, compaction and webview projection retain bounded diffs but remove private paths.

- [ ] **Step 1: Write reload/compaction projection tests**

Use literal tool parts containing diff hunks, snippets, a private spill path and
a large textual output. Assert session save/load and compaction preserve the
bounded structured fields while webview projection removes only private fields.

- [ ] **Step 2: Run focused tests and verify RED where coverage exposes gaps**

Run:

```bash
corepack pnpm --filter @nexuscode/core test -- session protocol
corepack pnpm --filter nexuscode test -- webview-projection controller
```

- [ ] **Step 3: Make the smallest serializer/projection corrections**

No new storage service: JSONL remains additive and ChangeSet remains the
authoritative full review data.

- [ ] **Step 4: Run focused tests and verify GREEN**

Require all commands from Step 2 to exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/session packages/core/src/protocol packages/vscode/src/webview-projection.test.ts packages/vscode/src/controller.test.ts
git commit -m "test: protect durable diff projections"
```

### Task 3: Honest compact extension file cards

**Files:**
- Create: `packages/vscode/webview-ui/src/components/fileChangePreview.ts`
- Create: `packages/vscode/webview-ui/src/components/fileChangePreview.test.ts`
- Modify: `packages/vscode/webview-ui/src/components/ToolCallCard.tsx`
- Modify: `packages/vscode/webview-ui/src/components/ToolCallCard.test.tsx`
- Modify: `packages/vscode/webview-ui/src/index.css`

**Interfaces:**
- Produces: `buildFileChangePreview(part, maxLines)` with exact
  `lines`, `hiddenLineCount`, `statusOnly`, and `stats`.
- Consumes: canonical persisted fields only; unified diff fallback is allowed
  only when actual diff syntax is present.

- [ ] **Step 1: Write failing semantic preview tests**

Literal cases:

- new file: two green lines;
- edit: red `BETA`, green `GAMMA`;
- legacy `<updated_content>` without hunks: zero synthetic lines and
  `statusOnly: true`;
- malformed hunks: ignored safely;
- 10 changed lines with max 6: six lines and four hidden.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/webview-ui test -- fileChangePreview.test.ts
```

Expected: module absent.

- [ ] **Step 3: Implement the pure preview builder**

Remove `parseSuccessfullyUpdatedOutput` and `buildFallbackDiffHunks`. Never
derive additions from full output.

- [ ] **Step 4: Run preview tests and verify GREEN**

Require zero failures.

- [ ] **Step 5: Write failing component tests**

Assert accessible header, exact filename/counts, red/green rows, status-only
legacy fallback, toggle behavior, and diff-open message.

- [ ] **Step 6: Run component tests and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/webview-ui test -- ToolCallCard.test.tsx
```

- [ ] **Step 7: Implement Cursor-like markup and CSS**

Use one small file icon, a 32px compact header, six-line preview, no nested
border around the preview, no large language badge, and stable overflow.

- [ ] **Step 8: Run focused webview tests and verify GREEN**

Run both files from Steps 2 and 6.

- [ ] **Step 9: Commit**

```bash
git add packages/vscode/webview-ui/src/components packages/vscode/webview-ui/src/index.css
git commit -m "fix: render honest compact file diffs"
```

### Task 4: Thought, Explored and Worked spacing/composition

**Files:**
- Modify: `packages/vscode/webview-ui/src/transcript/renderProjection.ts`
- Modify: `packages/vscode/webview-ui/src/transcript/renderProjection.test.ts`
- Modify: `packages/vscode/webview-ui/src/components/MessageList.tsx`
- Modify: `packages/vscode/webview-ui/src/components/CompletedWorkBlock.tsx`
- Modify: `packages/vscode/webview-ui/src/components/CompletedWorkBlock.test.tsx`
- Modify: `packages/vscode/webview-ui/src/components/ExploredProgressBlock.test.tsx`
- Modify: `packages/vscode/webview-ui/src/index.css`

**Interfaces:**
- Consumes: `ChatRenderItem` and existing exploration segment grouping.
- Produces: a dedicated `.nexus-worked-item` local row without global
  `message-list-item` spacing.

- [ ] **Step 1: Write failing projection/component tests**

Assert:

- one completed turn has one `completed_work`;
- final answer remains outside it;
- search tools count as exploration;
- expanded children do not use `message-list-item`;
- empty reasoning is omitted;
- multiple real reasoning segments remain ordered without duplicates.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/webview-ui test -- renderProjection.test.ts CompletedWorkBlock.test.tsx ExploredProgressBlock.test.tsx
```

- [ ] **Step 3: Implement local worked rows and spacing tokens**

Use an 8px local gap and remove the nested global wrapper. Preserve stable
message/part keys and the collapsed-by-default behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Require all focused tests to pass.

- [ ] **Step 5: Commit**

```bash
git add packages/vscode/webview-ui/src/transcript packages/vscode/webview-ui/src/components packages/vscode/webview-ui/src/index.css
git commit -m "fix: normalize completed work timeline spacing"
```

### Task 5: CLI parity for live and restored sessions

**Files:**
- Modify: `packages/cli/src/nexus-query.ts`
- Modify: `packages/cli/src/nexus-query-stream.test.ts`
- Modify: `packages/cli/src/components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx`
- Modify: `packages/cli/src/components/messages/UserToolResultMessage/UserToolSuccessMessage.test.tsx`
- Modify: `packages/cli/src/utils/messages.tsx`
- Modify: `packages/cli/src/utils/messages.test.tsx`

**Interfaces:**
- Consumes: durable `ToolPart.diffHunks`, `appliedReplacements`, `diffStats`.
- Produces: equivalent `tool_result` metadata for live events and
  `replMessagesFromSession`.

- [ ] **Step 1: Write failing live/reload parity tests**

Create one live event fixture and one persisted session fixture for the same
edit. Assert both produce red `BETA`, green `GAMMA`, and `+1/−1`.

- [ ] **Step 2: Run focused CLI tests and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/cli test -- nexus-query-stream.test.ts UserToolSuccessMessage.test.tsx messages.test.tsx
```

- [ ] **Step 3: Implement shared CLI projection**

Rebuild tool results from persisted tool parts without parsing human-readable
output. Keep legacy parts status-only when no real diff exists.

- [ ] **Step 4: Run focused CLI tests and verify GREEN**

Require zero failures.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src
git commit -m "fix: keep cli file diffs stable across reload"
```

### Task 6: Safe interaction matrix and visual verification

**Files:**
- Create or modify only test fixtures under:
  `packages/vscode/webview-ui/src/**/*.test.tsx`,
  `packages/cli/src/**/*.test.tsx`,
  and `/Users/mac/Projects/nexus/test`.
- Update: `docs/superpowers/checkpoints/2026-07-29-cursor-like-ui-validation.md`

**Interfaces:**
- Consumes: built extension and CLI.
- Produces: recorded evidence for each named scenario and screenshots of the
  representative extension states.

- [ ] **Step 1: Run automated interaction suites**

Cover Read, Glob/List, Grep/Search, Bash success/error/background,
Write/Edit/ApplyPatch, approval allow/deny, subagent progress/completion/error,
streaming chunks, queue send/cancel, compaction, Review/Undo/Keep and reload.

- [ ] **Step 2: Build the extension and CLI**

Run:

```bash
corepack pnpm typecheck
corepack pnpm build
```

- [ ] **Step 3: Run a minimal CLI smoke**

Use only `/Users/mac/Projects/nexus/test`, no indexing, and restore the fixture
after Write/Edit/Undo checks.

- [ ] **Step 4: Run controlled VS Code smoke**

Inspect compact layout at narrow and wide sidebar widths. Exercise live
Write/Edit, reload the webview/session, open Review, Undo, Keep, one Bash
command, one Search, one approval and one subagent. Capture screenshots and
verify no duplicate rows, false colors, clipped cards or large gaps.

- [ ] **Step 5: Compare against Cursor screenshots**

Check header density, spacing, filename/stats cluster, correct red/green
semantics, Worked collapse and final-answer separation.

- [ ] **Step 6: Write the validation checkpoint**

Record exact commands, counts, screenshots, known exclusions and cleanup
evidence. Do not claim untested scenarios.

### Task 7: Full release gate and push

**Files:**
- Modify only files required by failures found in the gate, using a new
  red-green cycle for each behavior.

**Interfaces:**
- Produces: fresh, auditable completion evidence and pushed `main`.

- [ ] **Step 1: Run the full repository test suite**

```bash
corepack pnpm test
```

- [ ] **Step 2: Run typecheck, build and runtime gates**

```bash
corepack pnpm typecheck
corepack pnpm build
corepack pnpm run verify:runtime
```

- [ ] **Step 3: Audit the objective requirement-by-requirement**

Map each explicit scenario to a passing automated test, controlled manual
evidence, or both. Treat missing evidence as incomplete and fix it.

- [ ] **Step 4: Inspect repository state**

```bash
git status --short
git diff --check
git log --oneline -8
```

- [ ] **Step 5: Commit any final verified corrections**

Use a scoped commit message that names the corrected behavior.

- [ ] **Step 6: Push main**

```bash
git push origin main
```

- [ ] **Step 7: Verify remote state**

Confirm local `HEAD` equals `origin/main` and report the exact commit.
