# TUI approval without readline; system prompt hint

## Summary

Approval in the CLI TUI no longer uses readline (which was blocking stdin and breaking the UI after answering). Approval is resolved via the TUI input bar: user types y/n/a/s and Enter; the host’s pending Promise is resolved from the main thread so the agent continues and the UI stays responsive.

## Changes

### 1. core: PermissionResult.skipAll
- **types.ts**: `PermissionResult` extended with optional `skipAll?: boolean` so the host can set “skip all” (autoApprove) when the user chooses “s”.

### 2. CLI host: TUI approval ref
- **host.ts**: `CliHost` constructor accepts optional `tuiApprovalRef: { current: ((r: PermissionResult) => void) | null }`. When set, `showApprovalDialog` does **not** use readline: it stores `resolve` in `tuiApprovalRef.current` and returns the Promise. The TUI later calls that resolve with the result (and sets `skipAll` for “s”). When `tuiApprovalRef` is not set, behavior is unchanged (readline for non-TUI/print mode).

### 3. CLI index + App: wire approval resolution
- **index.ts**: Created `approvalResolveRef`, passed to `CliHost`. App receives `onResolveApproval(result)` that calls `approvalResolveRef.current(result)` and clears the ref.
- **App.tsx**: When `state.awaitingApproval` and user presses Enter with input `y`/`n`/`a`/`s` (or yes/no/always/skip), we parse to `PermissionResult`, call `onResolveApproval`, clear input, reset `awaitingApproval`, reset `chatScrollLines` to 0 (so scroll works after approval). No double-submit, no readline conflict.

### 4. Status bar: system prompt hint
- **WelcomeBar**: Context line now ends with `· sys on` so it’s clear the system prompt is included in the context.

## Verification

- `pnpm run build:core` and `pnpm run build:cli` succeed.
- Approval flow: TUI shows “Allow? [y] Yes [n] No [a] Always [s] Skip — type below”; user types e.g. `s` + Enter; Promise resolves, agent continues, scroll and input work normally.
