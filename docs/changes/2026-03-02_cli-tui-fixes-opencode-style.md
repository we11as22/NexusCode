# CLI TUI fixes: duplicate message, simple-git, tools on top, scroll, approval

## Summary

Fixes for NexusCode CLI (with and without server): duplicate user message, simple-git on missing dir, tools/todo at top (OpenCode-style), scroll area and approval hint.

## Changes

### 1. simple-git "directory does not exist"
- **packages/core** `CheckpointTracker`: no longer call `simpleGit(shadowRoot)` in constructor (dir may not exist yet). Create `this.git` only in `initInternal()` after `fs.mkdir(shadowRoot)`. Added `getGit()` for lazy access. If `workspaceRoot` does not exist, skip `syncWorkspace` in init and in `commit()` so checkpoints don’t throw.

### 2. Duplicate user message ("привет" twice)
- **packages/cli** `App.tsx`: debounce submit with `lastSubmitRef` — ignore a second Enter within 400 ms so one physical Enter doesn’t add the message twice.

### 3. Tools and progress on top (OpenCode-style)
- **buildChatLines**: order is now: **Todo** (if any) → **Tools** (grouped) → **Subagents** → **Chat messages** → reasoning → streaming → compacting → error. Tools are no longer only at the bottom; progress is visible at the top.

### 4. Scrolling
- **ChatViewport**: `visibleHeight = Math.max(12, rows - 14)` (was `rows - 16`), added `minHeight={visibleHeight}` so the chat area has a stable height. Scroll hint text: "↑ Scroll up (PgUp / Ctrl+D) — N lines above · Ctrl+G or End = latest".

### 5. Approval (approve) UX
- **InputBar** when `awaitingApproval`: prompt text is now "Allow? [y] Yes [n] No [a] Always [s] Skip — type below" instead of "[AWAITING APPROVAL]".

## Verification

- `pnpm run build:core` and `pnpm run build:cli` succeed.
- Lint clean on modified files.
