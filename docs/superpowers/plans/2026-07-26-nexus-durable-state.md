# NexusCode Durable State, Memory, and Recovery Plan

> Execution follows the approved runtime rearchitecture design. The canonical baseline is portable JSONL plus atomic snapshots; SQLite remains an optional rebuildable projection and is not required by startup, coding, memory, orchestration, CLI, server, or VS Code.

**Goal:** Make every durable Nexus state transition crash-safe, migration-safe, cross-process-safe, inspectable, and consistent across CLI, server, and VS Code.

**Primary references:** Codex rollout journals/recovery, OpenClaude append-only session files and file locking, Kilo transactional repository/migration boundaries, Roo index metadata/cache lifecycle.

---

## Task 1: Add portable durable-filesystem primitives

**Files:**
- Create: `packages/core/src/storage/durable-fs.ts`
- Create: `packages/core/src/storage/durable-fs.test.ts`
- Create: `packages/core/src/storage/index.ts`
- Modify: `packages/core/src/index.ts`

- [x] Test atomic replacement, fsync, backup recovery, lock contention, stale-lock recovery, timeout, and cleanup.
- [x] Implement same-directory temporary writes with file and directory sync.
- [x] Implement an ownership-checked cross-process lock with bounded retry and stale-owner recovery.
- [x] Serialize same-process callers by canonical target path.
- [x] Export structured storage diagnostics; never silently replace corruption with empty state.
- [x] Verify core tests/typecheck and commit.

## Task 2: Version and harden the session journal

**Files:**
- Create: `packages/core/src/session/storage.test.ts`
- Modify: `packages/core/src/session/storage.ts`
- Modify: `packages/core/src/session/index.ts`
- Modify: `packages/server/src/session-fs-store.ts`
- Modify: affected server/core tests.

- [x] Reject unsafe session identifiers before resolving a path.
- [x] Define a v2 journal header and checksummed, monotonically sequenced snapshot records.
- [x] Append and sync under the durable lock; compact atomically at bounded size/record thresholds.
- [x] Recover the last verified snapshot after a torn/corrupt tail and quarantine rejected bytes.
- [x] Read legacy v1 JSONL without modification; back it up and migrate idempotently on the first write.
- [x] Add optimistic revisions to in-process sessions and transactional server mutations.
- [x] Test concurrent appends, stale-writer conflicts, rewind, pagination, corrupt tail, legacy migration, and all CRUD paths.
- [x] Verify core/server tests/typecheck and commit.

## Task 3: Make orchestration state transactional and recoverable

**Files:**
- Create: `packages/core/src/orchestration/runtime.test.ts`
- Modify: `packages/core/src/orchestration/runtime.ts`
- Modify: orchestration tool/parallel-agent callers as required.

- [x] Version orchestration snapshots and add an append-only transition journal.
- [x] Run every mutation as lock → reload → validate → append transition → replace snapshot.
- [x] Validate task status transitions, dependencies, parent/child lineage, and completion invariants.
- [x] Reconcile stale running agents/processes after restart instead of leaving immortal running state.
- [x] Preserve and migrate the legacy `state.json` with checksum-backed migration metadata.
- [x] Test concurrent runtime instances, forced truncated writes, recovery, idempotent retries, and migration.
- [x] Verify core tests/typecheck and commit.

## Task 4: Unify memory records and Unicode retrieval

**Files:**
- Create: `packages/core/src/memory/*`
- Modify: `packages/core/src/orchestration/memory-selection.ts`
- Modify: `packages/core/src/orchestration/memory-extraction.ts`
- Modify: `packages/core/src/context/auto-memory.ts`
- Modify: `packages/core/src/context/team-memory.ts`
- Modify: `packages/core/src/session/session-memory.ts`
- Modify: `packages/core/src/agent/loop.ts`

- [x] Introduce versioned memory records with scope, kind, provenance, trust, confidence, sensitivity, expiry, access metadata, and contradiction/supersession links.
- [x] Import legacy runtime memories and Markdown memory idempotently while retaining source provenance.
- [x] Implement Unicode-aware tokenization and deterministic lexical retrieval for Russian and non-Latin text.
- [x] Keep vector retrieval optional and merge it with lexical ranking only when healthy.
- [x] Enforce prompt budgets, citations, trust boundaries, redaction, deduplication, and contradiction filtering.
- [x] Serialize session/project consolidation and make writes atomic.
- [x] Test Russian retrieval, poisoning boundaries, expiry, contradictions, migration, budgets, and concurrent consolidation.
- [x] Verify core tests/typecheck and commit.

## Task 5: Persist run events, approvals, and compaction state

- [x] Add versioned run/event records with monotonic sequence and idempotency keys.
- [x] Persist an event before delivery and support replay after restart.
- [x] Persist unresolved approvals, mode, task links, tool artifacts, and memory citations through compaction.
- [x] Add reconnect/replay integration tests for local and server transports.
- [x] Verify all package tests/typecheck/builds and commit.

## Durable-state completion gate

- [ ] No critical path imports or requires SQLite.
- [ ] A killed write cannot destroy the last verified session, task graph, memory, or configuration snapshot.
- [ ] Two Nexus processes cannot silently overwrite each other's session or orchestration mutations.
- [ ] Legacy sessions/state/memory migrate idempotently with original data retained.
- [ ] Corruption is quarantined and reported; it never silently becomes empty fresh state.
- [ ] Russian memory queries retrieve relevant Cyrillic records without embeddings.
- [ ] CLI, server, and VS Code observe the same durable state and revision semantics.
- [ ] All first-party tests, typechecks, builds, migration fixtures, and recovery fixtures pass.
