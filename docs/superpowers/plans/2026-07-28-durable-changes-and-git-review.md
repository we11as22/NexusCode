# Durable Changes and Git Review Implementation Plan

**Checkpoint status:** implementation complete; final verification and
publication recorded below.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give NexusCode one restart-safe owner for proposed/applied/reverted file changes and one bounded, side-effect-free Git/diff service, then use those contracts consistently in the local CLI, Nexus server, and VS Code extension.

**Architecture:** Core owns `ChangeSetService`, its storage/file-system ports, the proposal/apply/revert state machine, and a shared read-only `GitService`. Local CLI and VS Code use the same checksummed file-backed change-set repository; the server binds the same service to its existing workspace SQLite runtime. Tool calls supply immutable session/turn/run/message/part identity, approvals bind the exact proposal hash, and every mutation uses compare-and-swap through a host file-mutation port. Checkpoints become exact, path-scoped restore plans instead of blanket shadow-Git reset/clean operations.

**Tech Stack:** Node.js 24.18.0, pnpm 10.8.1, TypeScript 5.5+, built-in `node:sqlite` in `@nexuscode/state`, `execa`, `diff`, Zod, Vitest 3.2.3, VS Code workspace APIs, existing durable-fs locks and atomic writes.

## Global Constraints

- Work directly on `main`; the user explicitly authorized this.
- Do not run live LLMs, real remote MCP servers, real network mutations, or destructive commands in tests.
- Real file and Git tests use temporary directories only.
- Read-only Git operations use argv, never a shell command string.
- Git inspection disables external diff, textconv, hooks, pager, prompts, and optional index locks as appropriate.
- Read-only Git operations never stage files, mutate the index, rename `.git`, clean the worktree, or run repository hooks/filters.
- Every command has a timeout and byte cap; every aggregate result has file/count/byte omission metadata.
- File contents and large diffs are content-addressed blobs, not inline SQLite fields.
- The extension host and webview do not import `node:sqlite`; only the server state adapter does.
- A proposal records before-state durably before approval is requested.
- Approval authorizes one exact proposal hash, not merely a path or tool name.
- Apply and revert are compare-and-swap operations and never overwrite later user or tool edits.
- Repeated edits to one path in one turn coalesce earliest-before/latest-after without hiding interleaved drift.
- A crash-visible `applying` or `reverting` record is reconciled by observed bytes, never guessed successful.
- Conflicts remain durable and visible until explicitly superseded, accepted, or safely retried.
- Hunk selection creates a new proposal and proposal hash.
- Chat rewind never claims workspace success after a partial/conflicted file restore.
- New focused production files should remain below 500 lines and must be split before 800 lines.
- Every behavior change follows RED → GREEN → REFACTOR.

---

## Source-grounded decisions

- **Codex `61a4488`:** adopt argv execution, command timeouts, hook/config isolation, helper-disabling diff flags, explicit untracked handling, and remote-workspace command ownership.
- **OpenClaude `a3dc345`:** preserve one core state machine behind host adapters; do not duplicate policy in UI transports.
- **Kilo `614c21ee81`:** adopt declarative diff-source capabilities, stale-result epochs, per-file lazy details, immediate refresh after mutation, and explicit unsupported operations.
- **Roo `b867ec9`:** retain sanitized Git-environment lessons; reject its blanket shadow `clean/reset` and nested-repository limitation as restore semantics.
- **Roo custom-tool runtime:** ship the cross-platform `esbuild-wasm` compiler
  with the VSIX, while retaining Nexus's stricter trusted-tree import policy
  instead of allowing the compiler to resolve arbitrary workspace paths.
- **Kimi Code `77618e3`:** adopt serialized undo, precondition checks against active/queued work, participant reconciliation, and explicit post-commit notification failures.
- **Kimi CLI `4a550ef`:** keep exact context checkpoints and compaction-aware undo limits, but do not conflate chat checkpoint ids with file ownership.
- **Qwen Code `3209b89`:** adopt NUL-delimited status/path parsing, untracked-file bounds, binary/FIFO defenses, fast-path omissions, merge/rebase detection, and side-effect-free Git inspection.
- **MiMo Code `076b790`:** adopt message/part-linked patch history and reversible user-visible session state; reject index-driven blanket restore as the authoritative mutation mechanism.
- **Cline/Roo/Kilo checkpoint lineage:** keep user-facing checkpoint timelines only as metadata and preview sources, never as permission to discard unrelated workspace state.

---

## File and responsibility map

### Core Git service

- Create `packages/core/src/git/types.ts` — typed repository/status/diff/log results, omissions, capabilities, and errors.
- Create `packages/core/src/git/runner.ts` — argv-only sanitized bounded command runner.
- Create `packages/core/src/git/status.ts` — porcelain-v2 `-z` parser including rename/unmerged/unborn/submodule state.
- Create `packages/core/src/git/diff.ts` — tracked/staged/untracked/binary diff collection and bounded per-file detail.
- Create `packages/core/src/git/service.ts` — workspace-bound read-only facade.
- Create `packages/core/src/git/*.test.ts` — parser, runner, real temporary-repository, and hostile-config tests.
- Modify `packages/core/src/index.ts` — public typed exports.

### Core durable change service

- Create `packages/core/src/changes/types.ts` — identities, records, transitions, blobs, conflicts, restore plans.
- Create `packages/core/src/changes/hash.ts` — canonical proposal/workspace/content hashes.
- Create `packages/core/src/changes/store.ts` — storage and blob ports.
- Create `packages/core/src/changes/file-store.ts` — checksummed locked local repository plus content-addressed blobs.
- Create `packages/core/src/changes/service.ts` — propose/approve/reject/apply/revert/recover/coalesce state machine.
- Create `packages/core/src/changes/restore-plan.ts` — exact selected-path restore planning.
- Create `packages/core/src/changes/*.test.ts` — state-machine, crash-recovery, conflict, coalescing, and batch tests.
- Modify `packages/core/src/agent/run-services.ts` — workspace-owned `git` and `changeSets` services.
- Modify `packages/core/src/types.ts` — immutable tool execution identity and CAS file-mutation port.
- Modify `packages/core/src/index.ts` — public typed exports.

### Server SQLite adapter

- Modify `packages/state/src/migrations.ts` — change-set metadata, file rows, transition journal, uniqueness, and ownership invariants.
- Create `packages/state/src/change-set-repository.ts` — transactional implementation of the core-compatible storage contract.
- Create `packages/state/src/change-set-repository.test.ts` — migration, idempotency, transition fencing, and reopen tests.
- Modify `packages/state/src/index.ts` — exports.
- Modify `packages/server/src/sqlite-workspace-runtime.ts` — bind one service per canonical workspace and close in dependency order.
- Modify `packages/server/src/run-session.ts` and `packages/server/src/server-turn-runner.ts` — pass durable execution identity to core.

### File tools and hosts

- Modify `packages/core/src/tools/built-in/write-file.ts` — proposal-first approval and service-owned apply.
- Modify `packages/core/src/tools/built-in/replace-in-file.ts` — same path and coalescing contract.
- Modify `packages/core/src/agent/tool-execution.ts` and `packages/core/src/agent/loop.ts` — authoritative identity/policy handoff.
- Modify `packages/cli/src/host.ts` — implement exact CAS create/replace/delete without owning proposal history.
- Modify `packages/vscode/src/host.ts` — implement exact CAS against saved or dirty editor state.
- Modify `packages/server/src/host.ts` — implement the same CAS port.
- Modify focused host/tool tests.

### Checkpoint, review, and surface integration

- Replace `packages/core/src/checkpoint/tracker.ts` restore behavior with change-set-backed path snapshots and restore plans.
- Modify `packages/core/src/checkpoint/storage.ts` and checkpoint types for exact message binding and restore metadata.
- Modify `packages/core/src/review/review.ts` and `packages/core/src/tools/built-in/git-inspect.ts` to use `GitService`.
- Modify `packages/cli/src/commands/review.ts`, `packages/cli/src/utils/git.ts`, `packages/cli/src/task-restore.ts`, and `packages/cli/src/screens/REPL.tsx`.
- Modify `packages/vscode/src/controller.ts`, `packages/vscode/src/host.ts`, and webview message/state components.
- Add server protocol capabilities and routes only for server-owned change sets; remote clients never infer Keep/Undo support.

---

### Task 1: Establish the bounded read-only Git execution boundary

**Production mutation or break caught:** A repository can currently activate configured diff/textconv helpers, inherited Git routing variables, a pager, or unbounded output; `GitInspect` also builds a shell string and review code silently drops errors.

**Files:**
- Create: `packages/core/src/git/types.ts`
- Create: `packages/core/src/git/runner.ts`
- Create: `packages/core/src/git/runner.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

```ts
export interface GitCommandLimits {
  timeoutMs: number
  maxStdoutBytes: number
  maxStderrBytes: number
}

export interface GitCommandResult {
  argv: readonly string[]
  exitCode: number
  stdout: Buffer
  stderr: Buffer
  timedOut: boolean
  truncated: boolean
}

export interface GitCommandRunner {
  run(args: readonly string[], limits?: Partial<GitCommandLimits>): Promise<GitCommandResult>
}
```

- [x] **Step 1: Write failing runner tests**

  Prove argv preserves spaces/newlines without shell interpretation, inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, pager/prompt variables are removed/overridden, timeout kills the child, and stdout/stderr overflow returns a typed bounded error.

- [x] **Step 2: Run focused tests and verify RED**

  Run:

  ```bash
  ./node_modules/.bin/vitest run src/git/runner.test.ts
  ```

  from `packages/core`.

  Expected: missing module/API failures.

- [x] **Step 3: Implement the minimal argv runner**

  Use `execa("git", argv, { shell: false, reject: false })`, a sanitized environment, `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `PAGER=cat`, `GIT_OPTIONAL_LOCKS=0`, disabled hooks, timeout, and byte caps. Preserve exit codes 0/1 for caller interpretation; never collapse execution failures to empty output.

- [x] **Step 4: Run focused tests and verify GREEN**

  Run the same command. Expected: PASS.

- [x] **Step 5: Refactor exports and error messages**

  Keep secrets and full inherited environment values out of diagnostics.

---

### Task 2: Parse complete repository status without mutation

**Production mutation or break caught:** Existing `git status --short` text is ambiguous for quoted paths, renames, unborn branches, conflicts, submodules, and NUL-containing parser boundaries; CLI and UI disagree about counts.

**Files:**
- Create: `packages/core/src/git/status.ts`
- Create: `packages/core/src/git/status.test.ts`
- Create: `packages/core/src/git/service.ts`
- Create: `packages/core/src/git/service.test.ts`

**Interfaces:**

```ts
export type GitEntryKind =
  | "ordinary"
  | "rename"
  | "unmerged"
  | "untracked"
  | "ignored"

export interface GitStatusSnapshot {
  available: boolean
  root?: string
  branch?: string
  oid?: string
  upstream?: string
  ahead: number
  behind: number
  unborn: boolean
  detached: boolean
  operation?: "merge" | "rebase" | "cherry-pick" | "revert" | "bisect"
  entries: readonly GitStatusEntry[]
  omissions: readonly GitOmission[]
}
```

- [x] **Step 1: Write parser fixtures first**

  Cover porcelain v2 records `1`, `2`, `u`, `?`, `!`, rename source records, spaces/newlines in paths, submodule flags, unborn and detached headers, and malformed/truncated records.

- [x] **Step 2: Verify RED**

  ```bash
  ./node_modules/.bin/vitest run src/git/status.test.ts src/git/service.test.ts
  ```

- [x] **Step 3: Implement parser and workspace-bound service**

  Invoke:

  ```text
  git --no-optional-locks status --porcelain=v2 --branch -z --untracked-files=all
  ```

  Resolve the canonical repository root once, detect operation markers through a bounded safe Git-dir resolution, and return `available:false` distinctly from an empty clean repository.

- [x] **Step 4: Verify GREEN and `git diff --check`**

---

### Task 3: Produce bounded tracked, staged, and untracked diffs

**Production mutation or break caught:** `git diff HEAD` omits untracked files, fails in unborn repositories, can invoke configured helpers, reads unbounded output, and reports binary/oversize omissions as “no changes.”

**Files:**
- Create: `packages/core/src/git/diff.ts`
- Create: `packages/core/src/git/diff.test.ts`
- Modify: `packages/core/src/git/service.ts`
- Modify: `packages/core/src/git/types.ts`

**Interfaces:**

```ts
export interface GitDiffRequest {
  scope: "working" | "staged" | "combined" | "range"
  from?: string
  to?: string
  paths?: readonly string[]
  detail?: "summary" | "patch"
}

export interface GitFileDiff {
  path: string
  oldPath?: string
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "unmerged"
  staged: boolean
  binary: boolean
  additions?: number
  deletions?: number
  patch?: string
  omitted?: GitOmission
}
```

- [x] **Step 1: Write temporary-repository failure tests**

  Cover staged-only, unstaged-only, same-file staged+unstaged, untracked text, untracked binary, rename/delete, unborn repository, merge conflict fixture, path with newline, FIFO/symlink refusal, oversize file, helper configuration, and aggregate file/output caps.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Implement summary/detail collection**

  Use `--no-ext-diff`, `--no-textconv`, `--submodule=short`, NUL name-status/numstat calls, and explicit untracked enumeration with `ls-files --others --exclude-standard -z`. Read untracked files only after `lstat` proves regular-file semantics, with concurrency and byte caps. Represent binary/oversize/skipped entries explicitly.

- [x] **Step 4: Verify GREEN**

---

### Task 4: Define the durable ChangeSet state machine and canonical hashes

**Production mutation or break caught:** Host-local maps lose pending/applied edit ownership on restart; approval is associated with a transient UI event rather than exact proposed bytes; repeated edits and crash states cannot be reconstructed.

**Files:**
- Create: `packages/core/src/changes/types.ts`
- Create: `packages/core/src/changes/hash.ts`
- Create: `packages/core/src/changes/hash.test.ts`
- Create: `packages/core/src/changes/store.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

```ts
export type ChangeSetState =
  | "proposed"
  | "approved"
  | "applying"
  | "applied"
  | "rejected"
  | "accepted"
  | "reverting"
  | "reverted"
  | "conflicted"

export interface ChangeIdentity {
  workspaceId: string
  sessionId: string
  turnId: string
  runId: string
  messageId: string
  partId: string
  toolCallId: string
}

export interface ChangeFileRecord {
  path: string
  operation: "create" | "modify" | "delete" | "rename"
  oldPath?: string
  before: FileStateRef
  after: FileStateRef
  hunks: readonly ChangeHunk[]
  binary: boolean
  omission?: ChangeOmission
}
```

- [x] **Step 1: Write hash/state validation tests**

  Prove canonical path ordering, mode/existence/blob participation, rename identity, hunk participation, stable hashes across process restarts, and rejection of invalid transition/state combinations.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Implement domain-only types and hashes**

  Use SHA-256 with explicit versioned length-delimited fields. Never hash ambiguous JSON serialization or host-native path separators.

- [x] **Step 4: Verify GREEN**

---

### Task 5: Implement checksummed local storage and blob ownership

**Production mutation or break caught:** A crash or concurrent CLI/extension process can truncate or overwrite pending edit metadata; inline content makes manifests unbounded; symlinked storage can escape the Nexus data root.

**Files:**
- Create: `packages/core/src/changes/file-store.ts`
- Create: `packages/core/src/changes/file-store.test.ts`
- Modify: `packages/core/src/changes/store.ts`
- Reuse: `packages/core/src/storage/durable-fs.ts`

**Storage layout:**

```text
~/.nexus/changes/<workspace-sha256>/
  manifest.v1.json
  blobs/sha256/<first-two>/<digest>
  journals/<change-set-id>.jsonl
```

- [x] **Step 1: Write real temporary-directory tests**

  Cover atomic reopen, concurrent writers under lock, manifest checksum mismatch, symlinked manifest/blob rejection, blob deduplication, orphan cleanup grace period, interrupted temp file, file modes, and bounded record counts.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Implement minimal locked store**

  Write blobs first with exclusive atomic replacement, then append transition evidence and atomically replace the checksummed manifest. Fsync through existing durable-fs helpers. Never delete a blob referenced by a nonterminal or retained record.

- [x] **Step 4: Verify GREEN**

---

### Task 6: Implement proposal, approval, apply, revert, and recovery

**Production mutation or break caught:** A file can drift after preview, crash after disk write but before state update, be manually edited before undo, or be partially reverted in a multi-file operation.

**Files:**
- Create: `packages/core/src/changes/service.ts`
- Create: `packages/core/src/changes/service.test.ts`
- Create: `packages/core/src/changes/recovery.test.ts`
- Create: `packages/core/src/changes/restore-plan.ts`
- Create: `packages/core/src/changes/restore-plan.test.ts`
- Modify: `packages/core/src/types.ts`

**Host file port:**

```ts
export interface HostFileState {
  exists: boolean
  content?: string
  mode?: number
  hash: string
}

export interface HostFileMutation {
  path: string
  expected: HostFileState
  next: HostFileState
}

applyFileMutation?(mutation: HostFileMutation): Promise<void>
```

- [x] **Step 1: Write state-machine tests with a deterministic fake file port**

  Cover capture-before-approval, exact approval hash, denial, stale approval, path serialization, same-turn coalescing, interleaved drift, applying-before-write, crash-before-write, crash-after-write, applied-before-notify, CAS conflict, revert CAS, create/delete/rename, batch preflight, compensation failure, and hunk-derived proposal hashes.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Implement minimal service**

  Serialize by canonical workspace+path. Journal `applying` before calling the file port and `applied` only after it returns. On recovery, classify observed bytes as before/after/neither and transition to approved/applied/conflicted respectively. Never retry a mutation merely because notification failed.

- [x] **Step 4: Verify GREEN**

- [x] **Step 5: Refactor transition guards into one table**

---

### Task 7: Bind exact execution identity through the agent loop

**Production mutation or break caught:** Core currently knows message/part ids but not durable turn/run ids; server and local surfaces can therefore attribute a change to the wrong accepted turn after queueing or restart.

**Files:**
- Modify: `packages/core/src/agent/loop.ts`
- Modify: `packages/core/src/agent/tool-execution.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/server/src/server-turn-runner.ts`
- Modify: `packages/server/src/run-session.ts`
- Modify: `packages/cli/src/nexus-query.ts`
- Modify: `packages/vscode/src/controller.ts`
- Add/modify focused identity tests.

- [x] **Step 1: Write failure tests**

  Prove queued server turn ids survive through to a file proposal, local identities are stable for the whole turn, parallel read/write tool calls retain distinct part/tool ids, and subagents receive their own run lineage.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Add immutable `executionIdentity` to `AgentLoopOptions` and `ToolContext`**

  Server uses admitted protocol ids. Local CLI/VS Code allocate and persist ids before the loop starts. Do not store current-turn identity on a shared workspace service.

- [x] **Step 4: Verify GREEN**

---

### Task 8: Replace host-owned pending edit maps with the ChangeSet service

**Production mutation or break caught:** CLI, VS Code, and server implement different pending/save/revert behavior and lose proposal state on process exit.

**Files:**
- Modify: `packages/core/src/tools/built-in/write-file.ts`
- Modify: `packages/core/src/tools/built-in/replace-in-file.ts`
- Modify: `packages/core/src/agent/tool-execution.ts`
- Modify: `packages/cli/src/host.ts`
- Modify: `packages/vscode/src/host.ts`
- Modify: `packages/server/src/host.ts`
- Modify focused tool and host tests.

- [x] **Step 1: Write cross-host contract tests**

  The same proposal/apply/revert suite must pass for fake core, CLI filesystem, VS Code dirty-buffer adapter, and server filesystem adapter. Include dirty editor drift, file creation races, delete races, and exact retry behavior.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Implement `applyFileMutation` in every host**

  VS Code compares the current dirty buffer and saved bytes, applies through one `WorkspaceEdit`, saves only the intended document, and reports conflict without reverting other buffers. CLI/server use secure canonical paths and atomic replacement.

- [x] **Step 4: Migrate Write/Edit**

  `propose` → show exact diff → request exact-hash approval → `approve` → `apply`. Denial calls `reject`. Tool metadata carries `changeSetId`, proposal hash, omissions, and accurate conflict state.

- [x] **Step 5: Remove transient maps and compatibility mutation wrappers**

  `Write`, `Edit`, `ApplyPatch`, CLI undo, and VS Code review use the durable
  ChangeSet service exclusively. Hosts expose only captured-state and
  compare-and-swap mutation ports; no `openFileEdit/saveFileEdit` runtime path
  remains.

- [x] **Step 6: Verify GREEN**

---

### Task 9: Add the server SQLite repository and runtime binding

**Production mutation or break caught:** A server restart currently cannot advertise or resolve file proposals/applied changes, and remote clients could only pretend Undo exists.

**Files:**
- Modify: `packages/state/src/migrations.ts`
- Create: `packages/state/src/change-set-repository.ts`
- Create: `packages/state/src/change-set-repository.test.ts`
- Modify: `packages/state/src/index.ts`
- Modify: `packages/server/src/sqlite-workspace-runtime.ts`
- Add runtime close/reopen tests.

- [x] **Step 1: Write migration/repository tests**

  Cover fresh migration, reopen, checksum ledger, workspace/session/run/turn ownership triggers, unique proposal hash, legal transitions, transition journal, conflict retention, and blob refs without inline bytes.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Add an append-only migration**

  Do not edit migrations 1–7. Add change-set tables and triggers as the next contiguous version.

- [x] **Step 4: Implement adapter and bind one service per workspace runtime**

  Close ingress/session work before change service, then database. Core consumes only its storage port, not SQLite types.

- [x] **Step 5: Verify GREEN and existing state integrity tests**

---

### Task 10: Replace destructive checkpoint restore with exact restore plans

**Production mutation or break caught:** `CheckpointTracker.resetHead()` currently runs shadow `git clean -fd` and `reset --hard`, can discard unrelated/untracked work, and staging temporarily renames nested `.git` directories.

**Files:**
- Modify: `packages/core/src/checkpoint/tracker.ts`
- Modify: `packages/core/src/checkpoint/storage.ts`
- Modify: `packages/core/src/checkpoint/utils.ts`
- Modify: `packages/core/src/types.ts`
- Create/modify checkpoint tests.

- [x] **Step 1: Write destructive-regression tests**

  Prove restore preserves unrelated modified/untracked/ignored files, nested repositories, later user edits, binary/oversize omissions, and dirty buffers; exact selected files restore when their current hashes match; partial conflict is durable and reported.

- [x] **Step 2: Verify RED against current `clean/reset`**

- [x] **Step 3: Store exact message binding and resolve workspace bytes through ChangeSet refs**

  A checkpoint entry includes a stable id and exact `messageId`; restore uses
  the content-addressed before/after refs already owned by effective change
  sets at that boundary. Keep old records readable as preview-only legacy
  entries rather than duplicating shadow-Git bytes into a second authority.

- [x] **Step 4: Implement preview and apply**

  Preflight exact current-content preconditions, retain durable conflict and
  compensation state, and apply through `ChangeSetService`. Do not touch Git
  metadata or unrelated paths.

- [x] **Step 5: Delete nested `.git` rename code and blanket restore**

- [x] **Step 6: Verify GREEN**

---

### Task 11: Unify GitInspect and review on `GitService`

**Production mutation or break caught:** Core review, CLI review, CLI utilities, and `GitInspect` use four parsers/runners with different safety and completeness; untracked changes can be reported as “nothing to review.”

**Files:**
- Modify: `packages/core/src/tools/built-in/git-inspect.ts`
- Modify: `packages/core/src/review/review.ts`
- Modify: `packages/cli/src/commands/review.ts`
- Modify: `packages/cli/src/utils/git.ts`
- Add focused review/tool tests.

- [x] **Step 1: Write parity tests**

  Feed one repository fixture through tool, core review, and CLI review; assert identical file inventory and explicit omissions for untracked/binary/oversize/unborn/conflict states.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Replace direct `execa`, `execFile`, and shell-string Git calls**

  Keep review prompt construction separate from repository inspection. Fail visibly when Git is unavailable or inspection is partial.

- [x] **Step 4: Verify GREEN**

---

### Task 12: Expose honest Keep/Undo and diff capabilities in CLI, server, and VS Code

**Production mutation or break caught:** VS Code tracks a private `sessionUnacceptedEdits` list, CLI only remembers the latest in-memory host, and remote mode cannot own rollback.

**Files:**
- Modify: `packages/cli/src/screens/REPL.tsx`
- Modify: `packages/cli/src/components/PromptInput.tsx`
- Modify: `packages/vscode/src/controller.ts`
- Modify relevant webview message/state/components.
- Modify: `packages/core/src/protocol/v2.ts`
- Modify server protocol service/routes and clients.

- [x] **Step 1: Write surface state tests**

  Cover restart with pending proposals, per-file Keep/Undo, Keep All/Undo All, partial conflict, unavailable server capability, stale result epochs, and dirty-buffer conflict.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Add typed change capabilities and snapshots**

  Server advertises only operations it owns. Remote clients render actions from advertised capabilities and durable ids. Local surfaces query the same service.

- [x] **Step 4: Replace private edit arrays**

  UI lists durable change records, loads file details lazily, refreshes after mutations, and keeps conflict/omission notices visible.

- [x] **Step 5: Verify GREEN**

---

### Task 13: Make chat rewind and file restore an explicit two-phase workflow

**Production mutation or break caught:** A partial file restore can be followed by chat rewind/save, making the transcript claim work that did not happen; compensation can also fail.

**Files:**
- Modify: `packages/cli/src/task-restore.ts`
- Modify: `packages/cli/src/screens/REPL.tsx`
- Modify: `packages/vscode/src/controller.ts`
- Modify session/restore tests.

- [x] **Step 1: Write failure-injection tests**

  Cover file preflight conflict, failure after first file, session save failure after file restore, compensation conflict, restart during applying/reverting, and chat-only fallback.

- [x] **Step 2: Verify RED**

- [x] **Step 3: Implement exact outcome handling**

  Rewind chat only after complete workspace restore. On session-save failure, attempt compare-and-swap compensation and persist a recovery block if the final state is ambiguous. Never discard conflict records.

- [x] **Step 4: Verify GREEN**

---

### Task 14: Remove legacy ownership and prove cross-surface behavior

**Files:**
- Remove obsolete pending edit arrays/maps and shadow restore helpers.
- Update: `docs/engineering/reference-comparison.md`
- Update: `docs/superpowers/specs/2026-07-28-change-ownership-and-recovery-design.md`
- Add a checkpoint report under `docs/superpowers/checkpoints/`.

- [x] **Step 1: Run focused package tests**

  ```bash
  corepack pnpm --filter @nexuscode/core test
  corepack pnpm --filter @nexuscode/state test
  corepack pnpm --filter @nexuscode/server test
  corepack pnpm --filter @nexuscode/cli test
  corepack pnpm --filter nexuscode test
  ```

- [x] **Step 2: Run all typechecks and production builds**

  ```bash
  corepack pnpm typecheck
  corepack pnpm build
  ```

- [x] **Step 3: Run runtime/portability/census validation**

  ```bash
  corepack pnpm test:runtime
  corepack pnpm census:features:check
  git diff --check
  ```

- [x] **Step 4: Run independent code review**

  Review mutations, crash recovery, storage/path safety, Git side effects, surface truthfulness, and backward compatibility. Fix every P0/P1 and rerun all affected suites.

- [x] **Step 5: Update documentation with measured evidence**

  Record exact test counts, commands, known lower-priority limitations, and source-project tradeoffs. Do not claim full product completion while unrelated audit work remains.

- [x] **Step 6: Commit and push the coherent checkpoint**

  ```bash
  git add <exact reviewed paths>
  git commit -m "feat: own durable changes and git review"
  git push origin main
  ```
