# Nexus Workspace Runtime and Transactional State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-turn runtime construction with one workspace-owned
runtime backed by transactional SQLite coordination state while preserving
Nexus JSONL rollouts as portable, recoverable audit history.

**Architecture:** A new `@nexuscode/state` package owns built-in
`node:sqlite`, migrations, transactions, and repositories. A
`WorkspaceRuntimeRegistry` owns one long-lived runtime per canonical directory,
and each runtime owns session coordinators, subagents, MCP, plugins, memory,
and background work. CLI and VS Code use the same typed command/event contract
through in-process or HTTP/NDJSON transports.

**Tech Stack:** Node.js 24.18.0 LTS, pnpm 10.8.1, TypeScript 5.5+, built-in
`node:sqlite`, Zod, Hono, Vitest 3.2.3, existing checksummed JSONL rollouts.

## Global Constraints

- Work directly on `main`; the user explicitly authorized this.
- Use no live LLM, real MCP server, real shell mutation, or system preference
  in automated tests.
- Tests use temporary directories and in-memory/fake providers and hosts.
- `better-sqlite3`, Bun, Electron-native SQLite, and runtime downloads are not
  production dependencies.
- The VS Code extension host and webview never open SQLite.
- SQLite stores coordination and query projections; JSONL remains the
  canonical portable transcript/audit rollout.
- Secrets, plugin code, checkpoints, file contents, code vectors, and large
  tool output are not stored as inline database blobs.
- Every mutation has an idempotency key or an explicitly non-retryable
  contract.
- Every state transition that affects replay is committed before publication.
- New focused files normally remain below 500 lines and never exceed 800 lines
  without a documented split.
- Every behavior change follows RED → GREEN → REFACTOR and receives a focused
  commit after verification.

---

## File and responsibility map

### New package: `packages/state`

- `package.json` — Node 24-only state package and test scripts.
- `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts` — isolated build and
  test configuration.
- `src/sqlite-driver.ts` — the only `node:sqlite` import and low-level adapter.
- `src/database.ts` — database lifecycle, PRAGMAs, migration lock, transaction
  boundary, integrity checks, and close.
- `src/migrations.ts` — ordered embedded SQL migrations and schema version.
- `src/schema.ts` — row and domain types without leaking `StatementSync`.
- `src/session-input-repository.ts` — idempotent admit/promote/list operations.
- `src/runtime-repository.ts` — workspaces, sessions, turns, runs, approvals,
  events, leases, and projection cursors.
- `src/index.ts` — public state package exports.
- `src/*.test.ts` — real SQLite tests in temporary directories.

### New core runtime files

- `packages/core/src/runtime/workspace-runtime-registry.ts` — canonical
  directory registry, reference ownership, close/reopen behavior.
- `packages/core/src/runtime/workspace-runtime.ts` — long-lived workspace
  services and immutable configuration snapshots.
- `packages/core/src/runtime/session-coordinator.ts` — serialized session
  mailbox and state machine.
- `packages/core/src/runtime/types.ts` — storage ports consumed by core without
  importing SQLite.
- `packages/core/src/runtime/*.test.ts` — fake-port contract tests.

### Protocol and transport files

- `packages/core/src/protocol/v2.ts` — Zod schemas for typed user input,
  commands, snapshots, envelopes, and errors during the first migration
  slice; extraction into `@nexuscode/protocol` follows once every consumer is
  migrated.
- `packages/core/src/server-client.ts` — v2 client methods and reconnect cursor.
- `packages/server/src/runtime-registry.ts` — process-owned registry setup and
  shutdown.
- `packages/server/src/routes/session-v2.ts` — thin validated command routes.
- `packages/server/src/app.ts` — route mounting and runtime injection.

### Migrated hosts

- `packages/server/src/run-session.ts` — delegates to `WorkspaceRuntime`.
- `packages/cli/src/nexus-bootstrap.ts`, `packages/cli/src/nexus-query.ts` —
  one embedded runtime or server client, never per-turn managers.
- `packages/vscode/src/services/runtime-connection.ts` — one shared connection
  and managed backend lifecycle.
- `packages/vscode/src/controller.ts` — compatibility adapter during
  decomposition.

---

### Task 1: Pin a SQLite-capable managed runtime

**Files:**
- Modify: `.nvmrc`
- Modify: `package.json`
- Modify: `scripts/runtime-version.mjs`
- Modify: `scripts/runtime-version.test.mjs`
- Modify: `scripts/storage-portability.test.mjs`
- Modify: `packages/core/package.json`
- Modify: `packages/core/tsup.config.ts`
- Modify: `packages/cli/package.json`
- Modify: `packages/server/package.json`
- Modify: `packages/vscode/package.json`
- Modify: `README.md`
- Modify: `DOCS.md`

**Interfaces:**
- Produces: exact runtime contract `Node.js 24.18.0`.
- Produces: `assertBuiltinSqlite(): void`.
- Preserves: prohibition on external native SQLite addons.

- [x] **Step 1: Change runtime tests first**

```js
test("accepts the pinned Node release", () => {
  assert.deepEqual(validateRuntimeVersion("24.18.0"), { ok: true })
})

test("rejects every unpinned runtime", () => {
  for (const version of ["20.19.2", "22.23.1", "24.17.0", "25.8.1"]) {
    assert.equal(validateRuntimeVersion(version).ok, false)
  }
})

test("the pinned runtime exposes built-in SQLite", async () => {
  const sqlite = await import("node:sqlite")
  assert.equal(typeof sqlite.DatabaseSync, "function")
})
```

- [x] **Step 2: Run tests under Node 24.18.0 and verify RED**

Run:

```bash
node --test scripts/runtime-version.test.mjs scripts/storage-portability.test.mjs
```

Expected: the old `20.19.2` expectation fails.

- [x] **Step 3: Pin Node 24.18.0 and keep addon portability**

Set `.nvmrc` and `engines.node` to `24.18.0`. Update TypeScript Node types and
tsup targets to Node 24. Change the portability test to reject
`better-sqlite3`, `sqlite3`, and Electron rebuild scripts while requiring
`node:sqlite` only inside `packages/state/src/sqlite-driver.ts`.

- [x] **Step 4: Verify runtime scripts**

Run:

```bash
node --test scripts/runtime-version.test.mjs scripts/storage-portability.test.mjs
corepack pnpm typecheck
```

Expected: PASS on the exact runtime with no external SQLite addon.

- [x] **Step 5: Commit**

```bash
git add .nvmrc package.json packages/*/package.json packages/core/tsup.config.ts scripts README.md DOCS.md pnpm-lock.yaml
git commit -m "build: pin the Nexus managed runtime to Node 24"
```

---

### Task 2: Add the SQLite database and migration boundary

**Files:**
- Create: `packages/state/package.json`
- Create: `packages/state/tsconfig.json`
- Create: `packages/state/tsup.config.ts`
- Create: `packages/state/vitest.config.ts`
- Create: `packages/state/src/sqlite-driver.ts`
- Create: `packages/state/src/database.ts`
- Create: `packages/state/src/migrations.ts`
- Create: `packages/state/src/schema.ts`
- Create: `packages/state/src/database.test.ts`
- Create: `packages/state/src/index.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`

**Interfaces:**

```ts
export interface NexusStateDatabaseOptions {
  path: string
  processId?: string
  now?: () => number
}

export class NexusStateDatabase {
  static open(options: NexusStateDatabaseOptions): NexusStateDatabase
  read<T>(fn: (db: StateConnection) => T): T
  transaction<T>(fn: (db: StateConnection) => T): T
  integrityCheck(): { ok: true } | { ok: false; messages: string[] }
  close(): void
}
```

- [x] **Step 1: Write real database lifecycle tests**

Tests open a temporary file and prove:

```ts
expect(db.read((cx) => cx.pragma("journal_mode"))).toBe("wal")
expect(db.read((cx) => cx.pragma("foreign_keys"))).toBe(1)
expect(db.read((cx) => cx.userVersion())).toBe(CURRENT_SCHEMA_VERSION)
expect(db.integrityCheck()).toEqual({ ok: true })
```

Add a transaction test that inserts two rows and throws after the first;
neither row may remain.

- [x] **Step 2: Run and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/state test -- src/database.test.ts
```

Expected: FAIL because the package and database class do not exist.

- [x] **Step 3: Implement the driver and embedded migrations**

The driver imports `DatabaseSync` only in `sqlite-driver.ts`. `open()` sets:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
```

Migration `001_initial_state` creates:

```sql
CREATE TABLE schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  canonical_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE session (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  title TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE durable_event (
  id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(aggregate_id, sequence)
);
```

Migrations run inside `BEGIN EXCLUSIVE`, verify stored checksums, and refuse a
modified previously applied migration.

- [x] **Step 4: Verify rollback, reopen, and checksum rejection**

Run:

```bash
corepack pnpm --filter @nexuscode/state test
corepack pnpm --filter @nexuscode/state typecheck
corepack pnpm --filter @nexuscode/state build
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml packages/state pnpm-lock.yaml
git commit -m "feat: add transactional Nexus state database"
```

---

### Task 3: Implement durable session input admission

**Files:**
- Modify: `packages/state/src/migrations.ts`
- Create: `packages/state/src/session-input-repository.ts`
- Create: `packages/state/src/session-input-repository.test.ts`
- Modify: `packages/state/src/schema.ts`
- Modify: `packages/state/src/index.ts`

**Interfaces:**

```ts
export type InputDelivery = "steer" | "queue"

export interface AdmittedInput {
  id: string
  sessionId: string
  admittedSequence: number
  promotedSequence?: number
  delivery: InputDelivery
  parts: readonly UserInputPartRecord[]
  createdAt: number
}

export class SessionInputRepository {
  admit(input: AdmitInput): AdmittedInput
  pending(sessionId: string, delivery?: InputDelivery): AdmittedInput[]
  promoteSteers(sessionId: string, cutoff: number): AdmittedInput[]
  promoteNextQueued(sessionId: string): AdmittedInput | undefined
}
```

- [x] **Step 1: Write admission and promotion tests**

Prove:

- repeated ID with identical payload returns the original row;
- repeated ID with changed payload throws `InputConflictError`;
- steer promotion respects a cutoff and FIFO;
- queue promotion returns exactly one FIFO row;
- concurrent database handles cannot allocate the same sequence;
- text and image parts survive a close/reopen round trip.

- [x] **Step 2: Run and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/state test -- src/session-input-repository.test.ts
```

Expected: FAIL because the repository is missing.

- [x] **Step 3: Add schema and transactional repository**

Add `aggregate_sequence` and `session_input` tables. Every admission uses
`BEGIN IMMEDIATE`, advances the session aggregate sequence, inserts a durable
`input.admitted` event, and inserts the inbox row in the same transaction.
Promotion updates `promoted_sequence` and inserts `input.promoted` atomically.

- [x] **Step 4: Verify repository behavior**

Run:

```bash
corepack pnpm --filter @nexuscode/state test
corepack pnpm --filter @nexuscode/state typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/state/src
git commit -m "feat: persist queued and steering session input"
```

---

### Task 4: Add runs, approvals, leases, and JSONL projection cursors

**Files:**
- Modify: `packages/state/src/migrations.ts`
- Create: `packages/state/src/runtime-repository.ts`
- Create: `packages/state/src/runtime-repository.test.ts`
- Modify: `packages/state/src/schema.ts`
- Modify: `packages/state/src/index.ts`

**Interfaces:**

```ts
export class RuntimeRepository {
  claimSession(input: ClaimSessionInput): SessionLease
  renewSessionLease(input: RenewLeaseInput): SessionLease
  releaseSessionLease(input: ReleaseLeaseInput): void
  startRun(input: StartRunInput): RunRecord
  finishRun(input: FinishRunInput): RunRecord
  createApproval(input: CreateApprovalInput): ApprovalRecord
  resolveApproval(input: ResolveApprovalInput): ApprovalRecord
  getProjectionCursor(sessionId: string): ProjectionCursor | undefined
  advanceProjectionCursor(input: AdvanceProjectionCursorInput): ProjectionCursor
}
```

- [x] **Step 1: Write lease and crash-state tests**

Prove:

- only the current owner can renew or release a lease;
- a non-expired owner blocks another writer;
- an expired owner can be replaced with a new epoch;
- one session cannot start two active runs;
- finishing a run is idempotent for the same terminal status and conflicts for
  a different terminal status;
- unresolved approvals survive reopen;
- projection cursors never move backwards or accept a mismatched checksum.

- [x] **Step 2: Run and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/state test -- src/runtime-repository.test.ts
```

Expected: FAIL because `RuntimeRepository` is missing.

- [x] **Step 3: Implement tables and repository**

Create `session_lease`, `run`, `approval`, and `rollout_projection` with unique
partial indexes for active runs and unresolved approvals. Use epochs rather
than trusting PIDs alone. Store no approval secret or unredacted environment.

- [x] **Step 4: Verify**

Run:

```bash
corepack pnpm --filter @nexuscode/state test
corepack pnpm --filter @nexuscode/state typecheck
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add packages/state/src
git commit -m "feat: persist Nexus run ownership and approvals"
```

---

### Task 5: Introduce `WorkspaceRuntimeRegistry`

**Files:**
- Create: `packages/core/src/runtime/types.ts`
- Create: `packages/core/src/runtime/workspace-runtime.ts`
- Create: `packages/core/src/runtime/workspace-runtime-registry.ts`
- Create: `packages/core/src/runtime/workspace-runtime-registry.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

```ts
export interface WorkspaceRuntimeFactory {
  create(canonicalDirectory: string): Promise<WorkspaceRuntime>
}

export class WorkspaceRuntimeRegistry {
  acquire(directory: string): Promise<WorkspaceRuntimeHandle>
  peek(directory: string): WorkspaceRuntime | undefined
  close(directory: string): Promise<boolean>
  closeAll(): Promise<void>
}
```

- [ ] **Step 1: Write registry ownership tests**

Prove:

- realpath aliases acquire the same runtime;
- concurrent acquire calls invoke the factory once;
- closing one handle does not close a runtime retained by another;
- `closeAll` is idempotent and waits for runtime cleanup;
- a failed factory creation is not cached;
- workspace A never exposes services from workspace B.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/core test -- src/runtime/workspace-runtime-registry.test.ts
```

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement registry and runtime lifecycle**

Use canonical realpaths, one creation promise per directory, reference-counted
handles, and explicit process shutdown. `WorkspaceRuntime` owns one
`ParallelAgentManager`, MCP supervisor handle, plugin scope, memory service,
index handle, and state ports.

- [ ] **Step 4: Verify**

Run:

```bash
corepack pnpm --filter @nexuscode/core test -- src/runtime
corepack pnpm --filter @nexuscode/core typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime packages/core/src/index.ts
git commit -m "refactor: own Nexus services by workspace runtime"
```

---

### Task 6: Implement the session coordinator state machine

**Files:**
- Create: `packages/core/src/runtime/session-coordinator.ts`
- Create: `packages/core/src/runtime/session-coordinator.test.ts`
- Modify: `packages/core/src/runtime/types.ts`
- Modify: `packages/core/src/runtime/workspace-runtime.ts`

**Interfaces:**

```ts
export type SessionPhase =
  | "idle"
  | "preparing"
  | "streaming"
  | "waiting_approval"
  | "executing_tools"
  | "compacting"
  | "settling"
  | "failed"
  | "interrupted"

export class SessionCoordinator {
  admit(command: AdmitSessionInputCommand): Promise<AdmittedInput>
  start(command: StartTurnCommand): Promise<TurnHandle>
  steer(command: SteerTurnCommand): Promise<AdmittedInput>
  queue(command: QueueTurnCommand): Promise<AdmittedInput>
  interrupt(command: InterruptTurnCommand): Promise<boolean>
  approve(command: ResolveApprovalCommand): Promise<void>
  snapshot(): Promise<SessionRuntimeSnapshot>
}
```

- [ ] **Step 1: Write state-machine tests with fake ports**

Prove:

- two simultaneous starts serialize and the second becomes queued;
- steer with the wrong expected turn ID conflicts;
- steer becomes visible only at a safe boundary;
- queue starts a distinct turn after settlement;
- interrupt cancels the active turn but does not delete queued input;
- an ambiguous running tool is marked interrupted during recovery;
- no command publishes an event before its repository commit resolves.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/core test -- src/runtime/session-coordinator.test.ts
```

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 3: Implement serialized command handling**

Use a promise-tail mailbox per session and injected repository/turn-runner
ports. Store immutable turn configuration/context epochs at start. Do not move
the existing 2,000-line agent loop into the coordinator; call it through a
`TurnRunner` interface.

- [ ] **Step 4: Verify**

Run:

```bash
corepack pnpm --filter @nexuscode/core test -- src/runtime
corepack pnpm --filter @nexuscode/core typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime
git commit -m "feat: coordinate durable Nexus session turns"
```

---

### Task 7: Add protocol v2 and migrate the server

**Files:**
- Create: `packages/core/src/protocol/v2.ts`
- Create: `packages/core/src/protocol/v2.test.ts`
- Modify: `packages/core/src/server-client.ts`
- Create: `packages/server/src/runtime-registry.ts`
- Create: `packages/server/src/routes/session-v2.ts`
- Create: `packages/server/src/routes/session-v2.test.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/src/run-session.ts`

**Interfaces:**

```ts
export const UserInputPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    mimeType: z.string().regex(/^image\//),
    data: z.string(),
  }),
  z.object({ type: z.literal("mention"), name: z.string(), path: z.string() }),
  z.object({ type: z.literal("skill"), name: z.string() }),
])

export const SessionCommandSchema = z.discriminatedUnion("type", [
  StartTurnCommandSchema,
  SteerTurnCommandSchema,
  QueueTurnCommandSchema,
  InterruptTurnCommandSchema,
  ResolveApprovalCommandSchema,
])
```

- [ ] **Step 1: Write protocol and route tests**

Prove:

- text and image parts round-trip;
- malformed/oversized images fail before runtime admission;
- unknown protocol versions return a structured unsupported-version error;
- idempotency key reuse with different content returns conflict;
- disconnect and reconnect with `afterSequence` replays each durable envelope
  exactly once;
- server routes never construct MCP or `ParallelAgentManager`.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
corepack pnpm --filter @nexuscode/core test -- src/protocol/v2.test.ts
corepack pnpm --filter @nexuscode/server test -- src/routes/session-v2.test.ts
```

Expected: FAIL because protocol v2 and routes do not exist.

- [ ] **Step 3: Implement schemas, thin routes, and shared registry**

The server owns one registry for its process. Routes validate/authenticate,
acquire the workspace runtime, submit one command, and stream stored envelopes.
Remove per-request MCP and agent-manager construction after parity tests pass.

- [ ] **Step 4: Verify**

Run:

```bash
corepack pnpm --filter @nexuscode/core test
corepack pnpm --filter @nexuscode/server test
corepack pnpm --filter @nexuscode/core typecheck
corepack pnpm --filter @nexuscode/server typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol packages/core/src/server-client.ts packages/server/src
git commit -m "feat: serve Nexus sessions through runtime protocol v2"
```

---

### Task 8: Migrate CLI and VS Code runtime ownership

**Files:**
- Create: `packages/vscode/src/services/runtime-connection.ts`
- Create: `packages/vscode/src/services/runtime-connection.test.ts`
- Modify: `packages/vscode/src/extension.ts`
- Modify: `packages/vscode/src/controller.ts`
- Modify: `packages/cli/src/nexus-bootstrap.ts`
- Modify: `packages/cli/src/nexus-query.ts`
- Modify: CLI and VS Code server-client tests.

**Interfaces:**
- Produces one `RuntimeConnectionService` per extension activation.
- Preserves CLI embedded mode through the same protocol handlers.

- [ ] **Step 1: Write lifecycle parity tests**

Prove:

- multiple webviews share one server/client/SSE connection;
- reconnect restores the selected session and queued input;
- switching a remote session clears local unaccepted-edit state;
- remote image input reaches the same typed runtime command as local input;
- CLI turn two can inspect/stop a background subagent created in turn one;
- changing a server URL draft has no effect until validated and applied.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
corepack pnpm --filter nexuscode test -- src/services/runtime-connection.test.ts
corepack pnpm --filter @nexuscode/cli test
```

Expected: FAIL against current per-turn construction.

- [ ] **Step 3: Implement shared clients and remove duplicate construction**

Create the extension connection service, inject it into providers/controllers,
and make `Controller` a UI/IDE bridge. CLI bootstrap owns one embedded runtime
for its process. Delete local/server branches that build a fresh MCP client or
parallel manager per message after the parity tests pass.

- [ ] **Step 4: Verify all surfaces**

Run:

```bash
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli packages/vscode packages/core packages/server
git commit -m "refactor: share one Nexus runtime across every surface"
```

---

## Completion gate

- [x] Node 24.18.0 is pinned and `node:sqlite` loads without an external addon.
- [x] Database migrations, integrity checks, reopen, rollback, and corruption
  handling are tested.
- [x] Session input admission, steering, and queue promotion are durable and
  idempotent.
- [x] Session ownership, runs, approvals, leases, and projection cursors are
  transactional.
- [ ] One canonical workspace directory maps to one runtime per process.
- [ ] A session has one active turn and a durable mailbox.
- [ ] Server routes are thin and never construct turn-owned managers.
- [ ] CLI and VS Code use the same command/event contract.
- [ ] Remote typed input preserves images and reconnect cursors.
- [ ] Background subagents remain controllable across later turns.
- [ ] Existing JSONL sessions remain readable and are never deleted by
  migration.
- [ ] Core, state, server, CLI, VS Code, and webview tests/typechecks/builds
  pass with no live external service.
