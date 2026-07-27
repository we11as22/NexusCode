import { createHash } from "node:crypto"
import type { StateConnection } from "./schema.js"

export interface StateMigration {
  version: number
  name: string
  sql: string
}

const INITIAL_STATE_SQL = `
CREATE TABLE IF NOT EXISTS schema_migration (
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

CREATE INDEX session_workspace_updated_idx
  ON session(workspace_id, updated_at DESC);

CREATE TABLE durable_event (
  id TEXT PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(aggregate_id, sequence)
);

CREATE INDEX durable_event_aggregate_sequence_idx
  ON durable_event(aggregate_id, sequence);
`

const SESSION_INPUT_SQL = `
CREATE TABLE aggregate_sequence (
  aggregate_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0)
);

CREATE TABLE session_input (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  delivery TEXT NOT NULL CHECK(delivery IN ('steer', 'queue')),
  admitted_sequence INTEGER NOT NULL CHECK(admitted_sequence > 0),
  promoted_sequence INTEGER CHECK(promoted_sequence > admitted_sequence),
  payload_checksum TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, admitted_sequence)
);

CREATE INDEX session_input_pending_idx
  ON session_input(session_id, delivery, admitted_sequence)
  WHERE promoted_sequence IS NULL;
`

const RUNTIME_OWNERSHIP_SQL = `
CREATE TABLE session_lease (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK(lease_epoch > 0),
  status TEXT NOT NULL
    CHECK(status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE UNIQUE INDEX run_one_active_per_session_idx
  ON run(session_id)
  WHERE status = 'running';

CREATE TABLE approval (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES run(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  redacted_summary TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN ('pending', 'approved', 'denied', 'cancelled')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE UNIQUE INDEX approval_one_pending_dedupe_idx
  ON approval(session_id, dedupe_key)
  WHERE status = 'pending';

CREATE INDEX approval_pending_session_idx
  ON approval(session_id, created_at)
  WHERE status = 'pending';

CREATE TABLE rollout_projection (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  checksum TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export const REQUIRED_RUNTIME_TRIGGER_DEFINITIONS = {
  approval_run_session_insert: `CREATE TRIGGER approval_run_session_insert
BEFORE INSERT ON approval
WHEN NEW.run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM run
    WHERE id = NEW.run_id AND session_id = NEW.session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'approval run must belong to the same session');
END`,
  approval_run_session_update: `CREATE TRIGGER approval_run_session_update
BEFORE UPDATE OF session_id, run_id ON approval
WHEN NEW.run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM run
    WHERE id = NEW.run_id AND session_id = NEW.session_id
  )
BEGIN
  SELECT RAISE(ABORT, 'approval run must belong to the same session');
END`,
  run_session_update_with_approval: `CREATE TRIGGER run_session_update_with_approval
BEFORE UPDATE OF session_id ON run
WHEN EXISTS (
  SELECT 1
  FROM approval
  WHERE run_id = OLD.id AND session_id != NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'approval run must belong to the same session');
END`,
  run_terminal_cancel_approvals: `CREATE TRIGGER run_terminal_cancel_approvals
AFTER UPDATE OF status ON run
WHEN OLD.status = 'running' AND NEW.status != 'running'
BEGIN
  UPDATE approval
  SET status = 'cancelled',
      resolved_at = COALESCE(NEW.finished_at, created_at)
  WHERE run_id = NEW.id AND status = 'pending';
END`,
  approval_pending_run_insert: `CREATE TRIGGER approval_pending_run_insert
BEFORE INSERT ON approval
WHEN NEW.status = 'pending'
  AND NEW.run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM run WHERE id = NEW.run_id AND status = 'running'
  )
BEGIN
  SELECT RAISE(ABORT, 'pending approval run must be running');
END`,
  approval_pending_run_update: `CREATE TRIGGER approval_pending_run_update
BEFORE UPDATE OF status, run_id ON approval
WHEN NEW.status = 'pending'
  AND NEW.run_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM run WHERE id = NEW.run_id AND status = 'running'
  )
BEGIN
  SELECT RAISE(ABORT, 'pending approval run must be running');
END`,
  session_turn_run_session_insert: `CREATE TRIGGER session_turn_run_session_insert
BEFORE INSERT ON session_turn
WHEN NOT EXISTS (
  SELECT 1 FROM run
  WHERE run.id = NEW.run_id AND run.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'turn run must belong to the same session');
END`,
  session_turn_input_session_insert: `CREATE TRIGGER session_turn_input_session_insert
BEFORE INSERT ON session_turn
WHEN NOT EXISTS (
  SELECT 1 FROM runtime_session_input
  WHERE runtime_session_input.id = NEW.input_id
    AND runtime_session_input.session_id = NEW.session_id
    AND runtime_session_input.reserved_turn_id = NEW.id
    AND runtime_session_input.reserved_run_id = NEW.run_id
)
BEGIN
  SELECT RAISE(ABORT, 'turn input reservation must belong to the same session');
END`,
} as const

export const REQUIRED_RUNTIME_TRIGGERS = Object.keys(
  REQUIRED_RUNTIME_TRIGGER_DEFINITIONS,
) as (keyof typeof REQUIRED_RUNTIME_TRIGGER_DEFINITIONS)[]

const APPROVAL_RUN_SESSION_INVARIANT_SQL = `
CREATE TABLE approval_quarantine (
  approval_id TEXT PRIMARY KEY,
  approval_session_id TEXT NOT NULL,
  original_run_id TEXT NOT NULL,
  run_session_id TEXT,
  original_status TEXT NOT NULL,
  original_resolved_at INTEGER,
  quarantined_at INTEGER NOT NULL,
  reason TEXT NOT NULL
);

-- Version 3 did not enforce approval/run session ownership. Preserve every
-- contaminated link for diagnosis, then fail closed before installing guards.
INSERT INTO approval_quarantine (
  approval_id,
  approval_session_id,
  original_run_id,
  run_session_id,
  original_status,
  original_resolved_at,
  quarantined_at,
  reason
)
SELECT
  approval.id,
  approval.session_id,
  approval.run_id,
  run.session_id,
  approval.status,
  approval.resolved_at,
  COALESCE(approval.resolved_at, approval.created_at),
  'run_session_mismatch'
FROM approval
LEFT JOIN run ON run.id = approval.run_id
WHERE approval.run_id IS NOT NULL
  AND (run.id IS NULL OR run.session_id != approval.session_id);

UPDATE approval
SET
  run_id = NULL,
  status = 'cancelled',
  resolved_at = COALESCE(resolved_at, created_at)
WHERE id IN (SELECT approval_id FROM approval_quarantine);

${REQUIRED_RUNTIME_TRIGGER_DEFINITIONS.approval_run_session_insert};

${REQUIRED_RUNTIME_TRIGGER_DEFINITIONS.approval_run_session_update};

${REQUIRED_RUNTIME_TRIGGER_DEFINITIONS.run_session_update_with_approval};
`

const TERMINAL_RUN_APPROVAL_INVARIANT_SQL = `
UPDATE approval
SET status = 'cancelled',
    resolved_at = COALESCE(
      resolved_at,
      (SELECT finished_at FROM run WHERE run.id = approval.run_id),
      created_at
    )
WHERE status = 'pending'
  AND run_id IN (
    SELECT id FROM run WHERE status != 'running'
  );

${REQUIRED_RUNTIME_TRIGGER_DEFINITIONS.run_terminal_cancel_approvals};

${REQUIRED_RUNTIME_TRIGGER_DEFINITIONS.approval_pending_run_insert};

${REQUIRED_RUNTIME_TRIGGER_DEFINITIONS.approval_pending_run_update};
`

const SESSION_RUNTIME_COORDINATION_SQL = `
CREATE TABLE runtime_session_sequence (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  last_input_sequence INTEGER NOT NULL CHECK(last_input_sequence >= 0)
);

CREATE TABLE runtime_session_input (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  delivery TEXT NOT NULL CHECK(delivery IN ('steer', 'queue')),
  admitted_sequence INTEGER NOT NULL CHECK(admitted_sequence > 0),
  promoted_sequence INTEGER CHECK(promoted_sequence > admitted_sequence),
  expected_turn_id TEXT,
  reserved_turn_id TEXT NOT NULL UNIQUE,
  reserved_run_id TEXT NOT NULL UNIQUE,
  payload_checksum TEXT NOT NULL,
  parts_json TEXT NOT NULL,
  execution_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  requeued_from_turn_id TEXT,
  UNIQUE(session_id, admitted_sequence),
  CHECK(
    (delivery = 'steer' AND expected_turn_id IS NOT NULL)
    OR (delivery = 'queue' AND expected_turn_id IS NULL)
  )
);

CREATE INDEX runtime_session_input_pending_idx
  ON runtime_session_input(session_id, delivery, admitted_sequence)
  WHERE promoted_sequence IS NULL;

CREATE TABLE session_turn (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES run(id) ON DELETE CASCADE,
  input_id TEXT NOT NULL UNIQUE REFERENCES runtime_session_input(id) ON DELETE RESTRICT,
  phase TEXT NOT NULL CHECK(
    phase IN (
      'preparing', 'streaming', 'waiting_approval', 'executing_tools',
      'compacting', 'settling', 'failed', 'interrupted'
    )
  ),
  execution_json TEXT NOT NULL,
  config_epoch INTEGER NOT NULL CHECK(config_epoch >= 0),
  context_epoch INTEGER NOT NULL CHECK(context_epoch >= 0),
  owner_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL CHECK(lease_epoch > 0),
  interrupt_requested_at INTEGER,
  interrupt_reason TEXT,
  result_status TEXT CHECK(
    result_status IS NULL
    OR result_status IN ('completed', 'failed', 'interrupted')
  ),
  result_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE UNIQUE INDEX session_turn_one_active_idx
  ON session_turn(session_id)
  WHERE result_status IS NULL;

CREATE TABLE session_command (
  command_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  command_type TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX session_command_session_created_idx
  ON session_command(session_id, created_at, command_id);

CREATE TABLE protocol_event_sequence (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0)
);

CREATE TABLE protocol_event (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  turn_id TEXT,
  run_id TEXT,
  parent_event_id TEXT,
  payload_json TEXT NOT NULL,
  emitted_at INTEGER NOT NULL,
  rollout_status TEXT NOT NULL
    CHECK(rollout_status IN ('pending', 'projected', 'not_applicable')),
  UNIQUE(session_id, sequence),
  CHECK(
    (turn_id IS NULL AND run_id IS NULL)
    OR (turn_id IS NOT NULL AND run_id IS NOT NULL)
  )
);

CREATE INDEX protocol_event_session_sequence_idx
  ON protocol_event(session_id, sequence);

${REQUIRED_RUNTIME_TRIGGER_DEFINITIONS.session_turn_run_session_insert};

${REQUIRED_RUNTIME_TRIGGER_DEFINITIONS.session_turn_input_session_insert};
`

const SESSION_NEXT_MODE_SQL = `
CREATE TABLE session_next_mode (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  requested_by_turn_id TEXT NOT NULL UNIQUE
    REFERENCES session_turn(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('agent', 'plan', 'ask', 'debug', 'review')),
  created_at INTEGER NOT NULL
);
`

export const STATE_MIGRATIONS: readonly StateMigration[] = [
  {
    version: 1,
    name: "initial_state",
    sql: INITIAL_STATE_SQL,
  },
  {
    version: 2,
    name: "session_input",
    sql: SESSION_INPUT_SQL,
  },
  {
    version: 3,
    name: "runtime_ownership",
    sql: RUNTIME_OWNERSHIP_SQL,
  },
  {
    version: 4,
    name: "approval_run_session_invariant",
    sql: APPROVAL_RUN_SESSION_INVARIANT_SQL,
  },
  {
    version: 5,
    name: "terminal_run_approval_invariant",
    sql: TERMINAL_RUN_APPROVAL_INVARIANT_SQL,
  },
  {
    version: 6,
    name: "session_runtime_coordination",
    sql: SESSION_RUNTIME_COORDINATION_SQL,
  },
  {
    version: 7,
    name: "session_next_mode",
    sql: SESSION_NEXT_MODE_SQL,
  },
]

export const CURRENT_SCHEMA_VERSION =
  STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1]?.version ?? 0

function migrationChecksum(migration: StateMigration): string {
  return createHash("sha256")
    .update(`${migration.version}\0${migration.name}\0${migration.sql}`)
    .digest("hex")
}

type AppliedMigrationRow = {
  version: number
  name: string
  checksum: string
}

function readMigrationTime(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      "Nexus state migration time must be a non-negative safe integer",
    )
  }
  return value
}

export function applyStateMigrations(
  connection: StateConnection,
  now: () => number,
): void {
  connection.exec("BEGIN EXCLUSIVE")
  try {
    connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL
      );
    `)

    const applied = connection.all<AppliedMigrationRow>(
      `SELECT version, name, checksum
       FROM schema_migration
       ORDER BY version`,
    )

    for (const [index, row] of applied.entries()) {
      const expectedVersion = index + 1
      if (row.version !== expectedVersion) {
        throw new Error(
          `Migration ledger must be contiguous: missing migration ${expectedVersion} before version ${row.version}`,
        )
      }
      const migration = STATE_MIGRATIONS[index]
      if (!migration || migration.version !== expectedVersion) {
        throw new Error(
          `Database schema version ${row.version} is newer than this NexusCode build`,
        )
      }
      if (row.name !== migration.name) {
        throw new Error(
          `Migration ${row.version} name mismatch: expected ${migration.name}, found ${row.name}`,
        )
      }
      const expectedChecksum = migrationChecksum(migration)
      if (row.checksum !== expectedChecksum) {
        throw new Error(
          `Migration ${row.version} checksum mismatch: the applied migration was modified`,
        )
      }
    }

    const ledgerVersion = applied.at(-1)?.version ?? 0
    const userVersion = connection.userVersion()
    if (userVersion !== ledgerVersion) {
      throw new Error(
        `SQLite user_version ${userVersion} does not match migration ledger version ${ledgerVersion}`,
      )
    }

    for (let index = applied.length; index < STATE_MIGRATIONS.length; index += 1) {
      const migration = STATE_MIGRATIONS[index]!
      if (migration.version !== index + 1) {
        throw new Error(
          `NexusCode migration definitions must be contiguous at version ${index + 1}`,
        )
      }

      connection.exec(migration.sql)
      connection.run(
        `INSERT INTO schema_migration
          (version, name, applied_at, checksum)
         VALUES (?, ?, ?, ?)`,
        [
          migration.version,
          migration.name,
          readMigrationTime(now),
          migrationChecksum(migration),
        ],
      )
      connection.exec(`PRAGMA user_version = ${migration.version}`)
    }

    if (connection.userVersion() !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `Failed to advance SQLite user_version to ${CURRENT_SCHEMA_VERSION}`,
      )
    }
    connection.exec("COMMIT")
  } catch (error) {
    try {
      connection.exec("ROLLBACK")
    } catch {
      // Preserve the migration error if SQLite already rolled the transaction back.
    }
    throw error
  }
}
