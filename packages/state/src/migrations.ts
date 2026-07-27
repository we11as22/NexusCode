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

    for (const row of applied) {
      const migration = STATE_MIGRATIONS.find(
        (candidate) => candidate.version === row.version,
      )
      if (!migration) {
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

    const appliedVersions = new Set(applied.map((migration) => migration.version))
    for (const migration of STATE_MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue

      connection.exec(migration.sql)
      connection.run(
        `INSERT INTO schema_migration
          (version, name, applied_at, checksum)
         VALUES (?, ?, ?, ?)`,
        [
          migration.version,
          migration.name,
          now(),
          migrationChecksum(migration),
        ],
      )
      connection.exec(`PRAGMA user_version = ${migration.version}`)
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
