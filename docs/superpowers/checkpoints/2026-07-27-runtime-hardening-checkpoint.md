# Nexus Runtime Hardening Checkpoint — 2026-07-27

This checkpoint records the current implementation boundary before the next
audit/implementation session.

## Architecture fixed at this checkpoint

- One workspace-owned server runtime is the authority for remote sessions.
- Built-in `node:sqlite` stores transactional coordination state: leases,
  idempotent input admission, turns/runs, approvals, queues, replay events,
  orchestration mailboxes, cleanup ledgers, and pending execution transitions.
- Checksummed JSONL remains the portable transcript/audit history and is
  checkpointed throughout a turn, including failure and interruption paths.
- CLI and VS Code use protocol v2 identities/cursors for remote runs.
- MCP and skills do not use a preflight LLM classifier. Deferred tools are
  discovered deterministically through BM25 `ToolSearch`; skills use exact
  name/metadata activation.
- Project files request capabilities and provide data. Host-owned trust,
  credentials, endpoints, permissions, and exact-content grants remain the
  authority boundary.

## Completed slices

- Workspace/runtime registry, SQLite migrations, leases, admission, approvals,
  replay, and durable server transcript checkpoints.
- Exact-content plugin/custom-tool trust, isolated plugin workers, hook
  gating, safe archive extraction, and project-authority promotion.
- Authorized MCP networking with redirect/DNS/size controls, safe tool names,
  prompt/resource transport, and explicit degraded readiness diagnostics.
- Deterministic deferred-tool activation and removal of the legacy runtime
  classifier/skill FTS path.
- Mode permissions, plan file gates, canonical `PlanExit`, retired
  `ExitPlanMode`, approval coordination, exact command grants, and cancellation.
- Compaction failure semantics, context/memory selection and extraction,
  bounded memory files, and maintenance scheduling.
- Durable background shell supervision and lifecycle-safe output handles.
- Durable owner-scoped subagent FIFO mailbox with restart-safe delivery,
  ACK-after-checkpoint, resume lineage, exact target resolution, and cleanup.
- Opaque large-tool-output capabilities, safe truncation, retention,
  cross-session references, `ToolOutputRead`, atomic checkpoints, and
  idempotent session cleanup.
- CLI/VS Code remote cursor recovery, event delivery without content
  fingerprint loss, optimistic-message admission handshake, `/clear`
  lifecycle correctness, and honest capability gates for unsupported remote
  rollback/fork/scoped approvals.

## Next high-priority slices

The MCP response-bound and post-receipt queued-turn items below were completed
in the 2026-07-28 checkpoint. The stronger durable outbox and change-ownership
work remains active there.

1. ~~Bound remote MCP response bodies before SDK parsing, including declared
   `Content-Length`, chunked bodies, and per-frame/per-message limits for
   long-lived SSE without imposing an incorrect lifetime cap.~~
2. Add a durable delete tombstone/live-writer fence under the same session
   ownership transaction as active turns.
3. ~~Make post-receipt accepted remote turn identities recoverable after client
   restart, including completion-before-snapshot, bounded pending projection,
   terminal ACK, failed-terminal, and replay-expiry races.~~ Add the pre-request
   durable outbox and exactly-once queue UI.
4. Implement server-side atomic session fork, including transcript prefix,
   summary, todo, context metadata, and failure atomicity.
5. Add server-owned scoped permission grants and redirect instructions, or
   keep those controls capability-gated on every remote surface.
6. Give protocol `mention` and `skill` input parts exact runtime semantics,
   including image-plus-mention prompts, instead of flattening them to text.
7. Finish server-owned profile revisions, remote skill catalog/manual
   compaction capabilities, and capability-driven settings visibility.
8. Decompose the oversized VS Code controller and remaining compatibility
   adapters after runtime behavior is fully pinned by tests.
9. Perform the final independent source comparison and end-to-end scenario
   audit before calling Nexus feature-complete.

## Safe validation boundary

Validation for this checkpoint uses temporary directories, fake providers and
hosts, local SQLite files, and source/build checks. It intentionally does not
invoke a live LLM, real MCP server, destructive shell command, external
plugin, or system-preference mutation.
