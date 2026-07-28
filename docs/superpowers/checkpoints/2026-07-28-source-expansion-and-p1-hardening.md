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

This closes the proven post-receipt restart bug. The CLI and VS Code clients
also persist the complete canonical command before POST, replay the exact
prepared/admitted command after a lost response, and clear it only after the
target terminal has been durably applied locally. The outbox is bounded,
checksummed, workspace/session scoped, and never attaches to another client's
active turn.

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

### Durable changes, ApplyPatch, and review

- Write, Edit, and strict Codex-style multi-file ApplyPatch share one
  proposal-first `ChangeSetService`.
- Approval binds exact session/turn/run/message/part/tool-call identity and an
  exact proposal hash.
- Local CLI/VS Code use the same checksummed file/blob store; the server uses a
  transactional built-in SQLite adapter.
- Apply/revert are compare-and-swap operations with crash-visible
  applying/reverting recovery and compensation after partial host failure.
- CLI, server, VS Code, and batch compensation report success only after the
  exact durable terminal state is observed; a non-throwing recovery to
  `conflicted` remains visible and is never counted as restored/reapplied.
- Repeated same-turn edits coalesce to earliest-before/latest-after without
  overwriting interleaved user changes.
- CLI, remote server, and VS Code expose durable review state and honest
  accept/revert capabilities. Multi-file patches remain one atomic review
  action and are labelled as such.
- Checkpoint restoration no longer renames nested `.git`, calls blanket
  reset/clean, or guesses a destructive target from a description. Legacy
  checkpoints without exact message binding are preview-only.

### Bounded Git and diff

- One argv-only Git service strips inherited routing/prompt/pager variables and
  disables external diff/textconv behavior.
- Status and diff cover staged, unstaged, untracked, renamed, deleted, binary,
  oversized, unborn-HEAD, unmerged, submodule, and explicit omission states.
- Time, stdout/stderr, file-count, per-file, and aggregate byte limits are
  enforced without touching the user index.
- GitInspect and review surfaces consume that shared typed result instead of
  independent shell strings and parsers.

### Memory, compaction, queues, and canonical resume

- Queued turns are bounded and exact identities survive queued/active/terminal
  restart races.
- Manual and automatic compaction use stale-history CAS, fail closed on
  truncated/incomplete summaries, and project completed summaries into
  structured session memory.
- Workspace session memory refresh is scheduled and bounded rather than
  injected once at process start.
- CLI resume accepts only canonical Nexus sessions. The separate transcript
  importer and its parallel rendering path were removed, so resumed work uses
  the same durable runtime/config/memory/MCP/skills/permission contracts as a
  newly created session.

## Code-proven work still required

1. Add Codex-grade OS sandbox brokers for local shell execution; application
   policy and approvals cannot substitute for kernel isolation.
2. Isolate trusted plugin hooks behind fine-grained capabilities/a separate
   process instead of granting the host process's full OS authority.
3. Add real Extension Host/UI automation and broaden complex multi-root
   workspace coverage.
4. Add selective multi-file/hunk review only by creating a new proposal and
   approval hash; never mutate an already-approved atomic patch in place.
5. Continue decomposing the large VS Code controller only behind behavioral
   tests; core policy and durable state are already outside it.
6. Resume arbitrary in-flight third-party provider/tool instructions across
   process death only if those providers/tools expose a safe resumable
   protocol. Today interrupted operations are truthfully terminated and
   recovered/retried at Nexus boundaries.

## Verification

All verification stayed inside temporary/local test fixtures:

- workspace tests: **1547 passed**;
- TypeScript typecheck: all packages passed;
- production workspace build: passed;
- production VSIX packaging: passed, including extension bundle, webview,
  Tree-sitter runtime, 36 language assets, 52 query assets, and the
  cross-platform `esbuild-wasm` custom-tool runtime;
- pinned-runtime, built-in SQLite, portability, and feature-census tests:
  **12 passed**;
- MCP/skills validation workflow: passed;
- `git diff --check`: passed;
- no live LLM, real MCP server, external plugin, destructive workspace reset,
  or system preference mutation was used.
