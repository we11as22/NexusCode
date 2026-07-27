# Nexus Change Ownership and Remote Recovery Design

**Status:** approved direction, implementation in progress
**Source basis:** Codex, OpenClaude, Kilo Code, Roo Code, Cline, OpenCode,
Claw Code, Kimi Code, Kimi CLI, MiMo Code, and Qwen Code.

## Problem

Two different safety domains were previously conflated:

1. a workspace snapshot can describe what bytes existed at a point in time;
2. an agent-owned change can prove which bytes Nexus is authorized to undo.

A blanket shadow-Git `clean/reset --hard` solves the first problem by violating
the second. Likewise, a session-wide active-turn snapshot cannot prove which
queued remote turn belongs to a restarting client.

The target design makes ownership explicit and durable. A restore, accept,
reject, retry, or reconnect may act only on the exact operation identity and
content hashes recorded before the side effect.

## Source-grounded decisions

- **Codex:** keep execution identity, replay cursor, approval, and filesystem
  authority explicit; isolate internal Git metadata from user repositories.
- **OpenClaude/OpenCode/MiMo:** reject ambiguous replacements, bind rewind to
  exact message/part identity, and retain redo/revert state durably.
- **Kimi Code:** capture content-addressed baselines synchronously before a
  write and expose per-file/all Keep and Undo.
- **Qwen Code:** include tracked, staged, unstaged, untracked, unborn-HEAD,
  binary, oversized, and skipped-file states without mutating the user index.
- **Roo/Cline:** use native diff UX and sanitized Git execution, but do not
  adopt their destructive `clean/reset --hard` restore behavior.
- **Kilo:** persist exact session rewind identity and report whether workspace
  restoration was completed, unavailable, or conflicted.

## Core-owned change sets

One `ChangeSetService` owns mutation state for CLI, VS Code, and server-hosted
runs. Host adapters render and apply operations; they do not invent separate
rollback semantics.

Each durable change set records:

- stable change-set id and workspace identity;
- session, turn, run, message, part, and tool-call identity;
- canonical path and operation (`create`, `modify`, `delete`, `rename`);
- before existence, content hash, mode, and content-addressed blob;
- proposed/after content hash, mode, and blob;
- structured hunks plus binary/rename/oversize/omission metadata;
- approval hash and state:
  `proposed | approved | applying | applied | rejected | accepted |
  reverting | reverted | conflicted`;
- timestamps, failure reason, and applying/recovery journal state.

Mutation invariants:

1. Capture before-state before yielding control or requesting approval.
2. Approval binds to the exact proposal hash.
3. Serialize mutations by canonical workspace and path.
4. Revalidate workspace identity and compare current bytes with recorded
   before-state immediately before apply.
5. Journal `applying` before the write and `applied` after durable replacement.
6. Undo proceeds only when current bytes match recorded after-state.
7. Repeated same-path edits in one turn coalesce to the earliest before-state
   and latest after-state.
8. Conflicted/failed entries remain durable and visible.
9. Hunk acceptance creates a new proposal with a new approval hash; it never
   edits an already-approved proposal in place.

## Checkpoint restoration

Workspace checkpoints are a recovery aid, not mutation authority.

- Never rename nested `.git` directories.
- Never run blanket `git clean -fd` or `reset --hard` against a user workspace.
- Capture an emergency pre-restore snapshot.
- Preview exact affected paths, dirty editor buffers, ignored/excluded paths,
  binary/oversized files, and unavailable content.
- Restore only explicitly selected paths whose current content still matches
  the recorded restore precondition.
- Bind message rollback only to an exact persisted message-to-checkpoint id.
  Timestamp, ordinal, and description heuristics may offer chat-only rewind;
  they may not select a destructive workspace target.
- Report complete, partial, conflicted, and unavailable outcomes separately.

## Git service

A shared argv-based `GitService` replaces ad-hoc shell strings.

- Sanitize inherited Git environment and disable external diff, textconv,
  filters, paging, prompting, and optional locks for read-only inspection.
- Apply time, output, file-count, and total-byte bounds.
- Parse porcelain v2 `-z`.
- Treat staged, unstaged, untracked, renamed, deleted, binary, submodule,
  unborn-HEAD, merge/rebase, skipped, and unavailable states explicitly.
- Read-only review never modifies the index.
- Mutating stage/unstage/commit/branch operations require typed capabilities,
  exact scope, and the normal permission pipeline.
- Remote clients render only server-advertised Git capabilities.

## Remote durable outbox

Queued identities in the session snapshot provide safe legacy recovery but are
not the final ownership contract. New clients use a durable outbox:

1. Read the replay high-water mark.
2. Generate the complete canonical `start_turn` command, including client-owned
   `commandId` and `inputId`.
3. Atomically persist `{command, baseAfterSequence, state: prepared}` before
   the network request.
4. Dispatch that exact command. The server's durable idempotency ledger returns
   the same reservation after a lost response.
5. Persist the exact receipt and transition to `admitted`.
6. Follow only its `{inputId, turnId, runId}`, acknowledging but never rendering
   competitor envelopes.
7. Clear the outbox only after the target terminal envelope and local transcript
   application are durably acknowledged.

An additive exact turn-status endpoint should expose queued/active/terminal,
execution snapshot, replay anchor, and terminal outcome for one exact
`turnId/runId`. Unknown or mismatched identities fail closed and never fall
back to the session's current active turn.

## Surface behavior

CLI and VS Code must share:

- the same durable proposals and conflict rules;
- per-file and all-file Keep/Undo;
- contextual diff with omissions disclosed;
- restart-safe pending/applied state;
- accurate partial-failure messages;
- no chat rewind when required file restoration conflicts;
- no local rollback claim in remote mode without server authority.

## Validation boundary

Tests use temporary workspaces, local SQLite databases, fake providers,
in-memory HTTP streams, and fake host adapters. They must not run a live LLM,
untrusted plugin, real remote MCP server, destructive repository command, or
machine-wide preference mutation.
