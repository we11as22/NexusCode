# Nexus Source Expansion and P1 Hardening Checkpoint — 2026-07-28

This is an implementation checkpoint, not a feature-complete declaration.

## Source inventory

The audit now uses executable code from all eleven local source trees:

| Project | Audited commit |
| --- | --- |
| Codex | `61a4488` |
| OpenClaude | `a3dc345` |
| Kilo Code | `614c21ee81` |
| Roo Code | `b867ec9` |
| Cline | `dd7a1c5` |
| OpenCode | `7534d23` |
| Claw Code | `4ea31c1` |
| Kimi Code | `77618e3` |
| Kimi CLI | `4a550ef` |
| MiMo Code | `076b790` |
| Qwen Code | `3209b89` |

Repository code, tests, schemas, host adapters, persistence, and failure paths
were treated as evidence; README claims were not.

## Completed in this slice

### Remote MCP pre-parse bounds

- Finite responses enforce declared and actually streamed byte limits before
  MCP SDK `json()`/`text()` parsing.
- Successful SSE uses a per-record limit, not a lifetime stream limit.
- Non-success SSE-labelled responses use the finite limit.
- Oversized, malformed, chunked, lying-`Content-Length`, abort, bodyless, and
  hung-cancel paths are covered.
- Defaults are 32 MiB so the existing 16 MiB decoded binary allowance still
  fits after base64 and JSON envelope overhead.

### Restart-safe accepted turn attachment

- Protocol snapshots may expose bounded opaque pending identities and immutable
  execution policy, never queued prompt content.
- CLI and VS Code retain their persisted `turnId/runId`; they no longer replace
  it with another client's active turn.
- The core client can wait through competitor envelopes and deliver only the
  exact queued reservation.
- Accepted turns remain recoverable when they finish before the first recovery
  snapshot, while outside the bounded pending-identity projection, or between
  the wrapper and attach snapshots.
- Retained replay is terminal-aware: an already-acknowledged terminal is found
  without duplicating delivered output or resurrecting a resolved approval.
- Durable failed terminals are surfaced once and clear their exact cursor;
  expired replay windows produce a visible loss error and quarantine the stale
  cursor instead of blocking all future turns.
- New clients opt into the additive pending projection; old strict protocol-v2
  clients retain their original snapshot shape.

This closes the proven post-receipt restart bug. The stronger pre-request
durable outbox remains the next recovery slice and is specified in
`2026-07-28-change-ownership-and-recovery-design.md`.

### Edit and CLI undo correctness

- Non-`replace_all` Edit rejects ambiguous duplicate matches as documented.
- CLI save compares current bytes with the approved preview before writing and
  retains the pending proposal on conflict.
- Repeated same-path edits coalesce to the true pre-turn and final post-turn
  states.
- CLI undo preflights every file, refuses to overwrite later manual changes,
  retains conflicted state, and does not rewind chat while file restoration is
  unsafe.
- Local CLI undo is a two-phase operation: restored files remain compensatable
  until the conversation rewind is durably confirmed. A failed save reloads
  authoritative chat state and returns files to the agent-written state.
- A missing/unreadable journal is never mistaken for a successful reload.
  Ambiguous recovery restores the in-memory transcript, attempts file
  compensation, and blocks further writes for that session until restart.
- Remote CLI undo is explicitly unavailable until the server owns a durable
  change-set/rewind command; it no longer claims a local-only rollback.

## Code-proven work still required

1. Replace cursor-only remote start with the durable prepared/admitted outbox
   and exact terminal lookup.
2. Replace destructive shadow checkpoint restore and nested `.git` renaming
   with core-owned content-addressed change sets and path-scoped restore.
3. Replace CLI review/ad-hoc Git calls with a bounded shared Git service that
   includes untracked/unborn/binary/skipped state and disables external helpers.
4. Persist VS Code/CLI Keep/Undo state, including a durable recovery marker
   for ambiguous cross-resource save failures, and add safe per-hunk acceptance.
5. Require exact message-to-checkpoint bindings for workspace rollback.
6. Close path check/use races with no-follow or handle-relative mutation where
   supported.
7. Complete delete tombstone fencing, atomic server fork, exact mention/skill
   semantics, server-owned scoped grants/profiles/manual compaction, and VS Code
   controller decomposition.

## Verification

All verification stayed inside temporary/local test fixtures:

- workspace tests: **1393 passed**;
- TypeScript typecheck: all packages passed;
- production workspace build: passed;
- pinned-runtime, built-in SQLite, portability, and feature-census tests:
  **12 passed**;
- `git diff --check`: passed;
- no live LLM, real MCP server, external plugin, destructive workspace reset,
  or system preference mutation was used.
