import type { NexusStateDatabase } from "./database.js"
import type { StateConnection } from "./schema.js"

export type RunStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"

export type TerminalRunStatus = Exclude<RunStatus, "running">
export type ApprovalStatus = "pending" | "approved" | "denied" | "cancelled"
export type ResolvedApprovalStatus = Exclude<ApprovalStatus, "pending">

const TERMINAL_RUN_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
])
const RESOLVED_APPROVAL_STATUSES = new Set<string>([
  "approved",
  "denied",
  "cancelled",
])

export interface RuntimeRepositoryOptions {
  now?: () => number
}

export interface ClaimSessionInput {
  sessionId: string
  ownerId: string
  ttlMs: number
}

export interface RenewLeaseInput extends ClaimSessionInput {
  epoch: number
}

export interface ReleaseLeaseInput {
  sessionId: string
  ownerId: string
  epoch: number
}

export interface SessionLease {
  sessionId: string
  ownerId: string
  epoch: number
  expiresAt: number
  updatedAt: number
}

export interface StartRunInput {
  id: string
  sessionId: string
  ownerId: string
  leaseEpoch: number
}

export interface FinishRunInput {
  runId: string
  ownerId: string
  leaseEpoch: number
  status: TerminalRunStatus
}

export interface RunRecord {
  id: string
  sessionId: string
  ownerId: string
  leaseEpoch: number
  status: RunStatus
  startedAt: number
  finishedAt?: number
}

export interface CreateApprovalInput {
  id: string
  sessionId: string
  runId?: string
  toolName: string
  redactedSummary: string
  dedupeKey: string
}

export interface ResolveApprovalInput {
  approvalId: string
  status: ResolvedApprovalStatus
}

export interface ApprovalRecord {
  id: string
  sessionId: string
  runId?: string
  toolName: string
  redactedSummary: string
  dedupeKey: string
  status: ApprovalStatus
  createdAt: number
  resolvedAt?: number
}

export interface AdvanceProjectionCursorInput {
  sessionId: string
  sequence: number
  checksum: string
  expectedPreviousChecksum?: string
}

export interface ProjectionCursor {
  sessionId: string
  sequence: number
  checksum: string
  updatedAt: number
}

export class RuntimeConflictError extends Error {
  readonly code:
    | "lease_conflict"
    | "lease_lost"
    | "run_conflict"
    | "approval_conflict"
    | "projection_conflict"

  constructor(code: RuntimeConflictError["code"], message: string) {
    super(message)
    this.name = "RuntimeConflictError"
    this.code = code
  }
}

type SessionLeaseRow = {
  session_id: string
  owner_id: string
  epoch: number
  expires_at: number
  updated_at: number
}

type RunRow = {
  id: string
  session_id: string
  owner_id: string
  lease_epoch: number
  status: RunStatus
  started_at: number
  finished_at: number | null
}

type ApprovalRow = {
  id: string
  session_id: string
  run_id: string | null
  tool_name: string
  redacted_summary: string
  dedupe_key: string
  status: ApprovalStatus
  created_at: number
  resolved_at: number | null
}

type ProjectionCursorRow = {
  session_id: string
  sequence: number
  checksum: string
  updated_at: number
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty`)
  }
}

function assertEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error("Lease epoch must be a positive safe integer")
  }
}

function assertTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new Error("Lease TTL must be a positive safe integer")
  }
}

function leaseFromRow(row: SessionLeaseRow): SessionLease {
  return {
    sessionId: row.session_id,
    ownerId: row.owner_id,
    epoch: row.epoch,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
  }
}

function runFromRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    leaseEpoch: row.lease_epoch,
    status: row.status,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  }
}

function approvalFromRow(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    toolName: row.tool_name,
    redactedSummary: row.redacted_summary,
    dedupeKey: row.dedupe_key,
    status: row.status,
    createdAt: row.created_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
  }
}

function projectionFromRow(row: ProjectionCursorRow): ProjectionCursor {
  return {
    sessionId: row.session_id,
    sequence: row.sequence,
    checksum: row.checksum,
    updatedAt: row.updated_at,
  }
}

function loadLease(
  connection: StateConnection,
  sessionId: string,
): SessionLeaseRow | undefined {
  return connection.get<SessionLeaseRow>(
    `SELECT session_id, owner_id, epoch, expires_at, updated_at
     FROM session_lease
     WHERE session_id = ?`,
    [sessionId],
  )
}

function loadRun(
  connection: StateConnection,
  runId: string,
): RunRow | undefined {
  return connection.get<RunRow>(
    `SELECT id, session_id, owner_id, lease_epoch, status,
            started_at, finished_at
     FROM run
     WHERE id = ?`,
    [runId],
  )
}

function loadApproval(
  connection: StateConnection,
  approvalId: string,
): ApprovalRow | undefined {
  return connection.get<ApprovalRow>(
    `SELECT id, session_id, run_id, tool_name, redacted_summary,
            dedupe_key, status, created_at, resolved_at
     FROM approval
     WHERE id = ?`,
    [approvalId],
  )
}

function loadProjection(
  connection: StateConnection,
  sessionId: string,
): ProjectionCursorRow | undefined {
  return connection.get<ProjectionCursorRow>(
    `SELECT session_id, sequence, checksum, updated_at
     FROM rollout_projection
     WHERE session_id = ?`,
    [sessionId],
  )
}

export class RuntimeRepository {
  readonly #database: NexusStateDatabase
  readonly #now: () => number

  constructor(
    database: NexusStateDatabase,
    options: RuntimeRepositoryOptions = {},
  ) {
    this.#database = database
    this.#now = options.now ?? Date.now
  }

  claimSession(input: ClaimSessionInput): SessionLease {
    assertNonEmpty(input.sessionId, "Session id")
    assertNonEmpty(input.ownerId, "Owner id")
    assertTtl(input.ttlMs)
    return this.#database.transaction((connection) => {
      const now = this.#now()
      const expiresAt = now + input.ttlMs
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error("Lease expiry exceeds the safe integer range")
      }
      const existing = loadLease(connection, input.sessionId)
      if (!existing) {
        connection.run(
          `INSERT INTO session_lease
            (session_id, owner_id, epoch, expires_at, updated_at)
           VALUES (?, ?, 1, ?, ?)`,
          [input.sessionId, input.ownerId, expiresAt, now],
        )
        return {
          sessionId: input.sessionId,
          ownerId: input.ownerId,
          epoch: 1,
          expiresAt,
          updatedAt: now,
        }
      }

      const live = existing.expires_at > now
      if (live && existing.owner_id !== input.ownerId) {
        throw new RuntimeConflictError(
          "lease_conflict",
          `Session ${input.sessionId} is owned by ${existing.owner_id}`,
        )
      }
      const epoch = live ? existing.epoch : existing.epoch + 1
      if (!live) {
        connection.run(
          `UPDATE run
           SET status = 'interrupted', finished_at = ?
           WHERE session_id = ? AND status = 'running'`,
          [now, input.sessionId],
        )
      }
      connection.run(
        `UPDATE session_lease
         SET owner_id = ?, epoch = ?, expires_at = ?, updated_at = ?
         WHERE session_id = ?`,
        [input.ownerId, epoch, expiresAt, now, input.sessionId],
      )
      return {
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        epoch,
        expiresAt,
        updatedAt: now,
      }
    })
  }

  renewSessionLease(input: RenewLeaseInput): SessionLease {
    assertNonEmpty(input.sessionId, "Session id")
    assertNonEmpty(input.ownerId, "Owner id")
    assertEpoch(input.epoch)
    assertTtl(input.ttlMs)
    return this.#database.transaction((connection) => {
      const now = this.#now()
      const existing = loadLease(connection, input.sessionId)
      if (
        !existing ||
        existing.owner_id !== input.ownerId ||
        existing.epoch !== input.epoch ||
        existing.expires_at <= now
      ) {
        throw new RuntimeConflictError(
          "lease_lost",
          `Lease ${input.sessionId}@${input.epoch} is no longer owned by ${input.ownerId}`,
        )
      }
      const expiresAt = now + input.ttlMs
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error("Lease expiry exceeds the safe integer range")
      }
      connection.run(
        `UPDATE session_lease
         SET expires_at = ?, updated_at = ?
         WHERE session_id = ? AND owner_id = ? AND epoch = ?`,
        [expiresAt, now, input.sessionId, input.ownerId, input.epoch],
      )
      return {
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        epoch: input.epoch,
        expiresAt,
        updatedAt: now,
      }
    })
  }

  releaseSessionLease(input: ReleaseLeaseInput): void {
    assertNonEmpty(input.sessionId, "Session id")
    assertNonEmpty(input.ownerId, "Owner id")
    assertEpoch(input.epoch)
    this.#database.transaction((connection) => {
      const result = connection.run(
        `DELETE FROM session_lease
         WHERE session_id = ? AND owner_id = ? AND epoch = ?`,
        [input.sessionId, input.ownerId, input.epoch],
      )
      if (Number(result.changes) !== 1) {
        throw new RuntimeConflictError(
          "lease_lost",
          `Lease ${input.sessionId}@${input.epoch} is no longer owned by ${input.ownerId}`,
        )
      }
    })
  }

  startRun(input: StartRunInput): RunRecord {
    assertNonEmpty(input.id, "Run id")
    assertNonEmpty(input.sessionId, "Session id")
    assertNonEmpty(input.ownerId, "Owner id")
    assertEpoch(input.leaseEpoch)
    return this.#database.transaction((connection) => {
      const existingRun = loadRun(connection, input.id)
      if (existingRun) {
        if (
          existingRun.session_id === input.sessionId &&
          existingRun.owner_id === input.ownerId &&
          existingRun.lease_epoch === input.leaseEpoch &&
          existingRun.status === "running"
        ) {
          return runFromRow(existingRun)
        }
        throw new RuntimeConflictError(
          "run_conflict",
          `Run id ${input.id} already exists with different ownership or state`,
        )
      }

      const now = this.#now()
      const lease = loadLease(connection, input.sessionId)
      if (
        !lease ||
        lease.owner_id !== input.ownerId ||
        lease.epoch !== input.leaseEpoch ||
        lease.expires_at <= now
      ) {
        throw new RuntimeConflictError(
          "lease_lost",
          `Cannot start run without the live lease ${input.sessionId}@${input.leaseEpoch}`,
        )
      }
      const active = connection.get<{ id: string }>(
        `SELECT id FROM run
         WHERE session_id = ? AND status = 'running'`,
        [input.sessionId],
      )
      if (active) {
        throw new RuntimeConflictError(
          "run_conflict",
          `Session ${input.sessionId} already has active run ${active.id}`,
        )
      }

      connection.run(
        `INSERT INTO run
          (id, session_id, owner_id, lease_epoch, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
        [input.id, input.sessionId, input.ownerId, input.leaseEpoch, now],
      )
      return {
        id: input.id,
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        leaseEpoch: input.leaseEpoch,
        status: "running",
        startedAt: now,
      }
    })
  }

  finishRun(input: FinishRunInput): RunRecord {
    assertNonEmpty(input.runId, "Run id")
    assertNonEmpty(input.ownerId, "Owner id")
    assertEpoch(input.leaseEpoch)
    if (!TERMINAL_RUN_STATUSES.has(input.status)) {
      throw new Error("finishRun requires a terminal status")
    }
    return this.#database.transaction((connection) => {
      const existing = loadRun(connection, input.runId)
      if (!existing) {
        throw new RuntimeConflictError(
          "run_conflict",
          `Run ${input.runId} does not exist`,
        )
      }
      if (existing.status !== "running") {
        if (existing.status === input.status) {
          return runFromRow(existing)
        }
        throw new RuntimeConflictError(
          "run_conflict",
          `Run ${input.runId} already finished as ${existing.status}`,
        )
      }
      const now = this.#now()
      const lease = loadLease(connection, existing.session_id)
      if (
        existing.owner_id !== input.ownerId ||
        existing.lease_epoch !== input.leaseEpoch ||
        !lease ||
        lease.owner_id !== input.ownerId ||
        lease.epoch !== input.leaseEpoch ||
        lease.expires_at <= now
      ) {
        throw new RuntimeConflictError(
          "lease_lost",
          `Cannot finish run ${input.runId} without its live fenced lease`,
        )
      }
      const finishedAt = now
      connection.run(
        `UPDATE run
         SET status = ?, finished_at = ?
         WHERE id = ? AND status = 'running'
           AND owner_id = ? AND lease_epoch = ?`,
        [
          input.status,
          finishedAt,
          input.runId,
          input.ownerId,
          input.leaseEpoch,
        ],
      )
      return runFromRow({
        ...existing,
        status: input.status,
        finished_at: finishedAt,
      })
    })
  }

  createApproval(input: CreateApprovalInput): ApprovalRecord {
    assertNonEmpty(input.id, "Approval id")
    assertNonEmpty(input.sessionId, "Session id")
    assertNonEmpty(input.toolName, "Tool name")
    assertNonEmpty(input.redactedSummary, "Redacted approval summary")
    assertNonEmpty(input.dedupeKey, "Approval dedupe key")
    if (input.runId !== undefined) assertNonEmpty(input.runId, "Run id")

    return this.#database.transaction((connection) => {
      const existing = loadApproval(connection, input.id)
      if (existing) {
        const same =
          existing.session_id === input.sessionId &&
          (existing.run_id ?? undefined) === input.runId &&
          existing.tool_name === input.toolName &&
          existing.redacted_summary === input.redactedSummary &&
          existing.dedupe_key === input.dedupeKey
        if (same) return approvalFromRow(existing)
        throw new RuntimeConflictError(
          "approval_conflict",
          `Approval id ${input.id} already exists with different content`,
        )
      }

      const duplicate = connection.get<ApprovalRow>(
        `SELECT id, session_id, run_id, tool_name, redacted_summary,
                dedupe_key, status, created_at, resolved_at
         FROM approval
         WHERE session_id = ? AND dedupe_key = ? AND status = 'pending'`,
        [input.sessionId, input.dedupeKey],
      )
      if (duplicate) {
        const same =
          (duplicate.run_id ?? undefined) === input.runId &&
          duplicate.tool_name === input.toolName &&
          duplicate.redacted_summary === input.redactedSummary
        if (same) return approvalFromRow(duplicate)
        throw new RuntimeConflictError(
          "approval_conflict",
          `Pending approval dedupe key ${input.dedupeKey} has different content`,
        )
      }

      const createdAt = this.#now()
      connection.run(
        `INSERT INTO approval
          (id, session_id, run_id, tool_name, redacted_summary, dedupe_key,
           status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          input.id,
          input.sessionId,
          input.runId ?? null,
          input.toolName,
          input.redactedSummary,
          input.dedupeKey,
          createdAt,
        ],
      )
      return {
        id: input.id,
        sessionId: input.sessionId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        toolName: input.toolName,
        redactedSummary: input.redactedSummary,
        dedupeKey: input.dedupeKey,
        status: "pending",
        createdAt,
      }
    })
  }

  resolveApproval(input: ResolveApprovalInput): ApprovalRecord {
    assertNonEmpty(input.approvalId, "Approval id")
    if (!RESOLVED_APPROVAL_STATUSES.has(input.status)) {
      throw new Error("resolveApproval requires a terminal status")
    }
    return this.#database.transaction((connection) => {
      const existing = loadApproval(connection, input.approvalId)
      if (!existing) {
        throw new RuntimeConflictError(
          "approval_conflict",
          `Approval ${input.approvalId} does not exist`,
        )
      }
      if (existing.status !== "pending") {
        if (existing.status === input.status) return approvalFromRow(existing)
        throw new RuntimeConflictError(
          "approval_conflict",
          `Approval ${input.approvalId} already resolved as ${existing.status}`,
        )
      }
      const resolvedAt = this.#now()
      connection.run(
        `UPDATE approval
         SET status = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
        [input.status, resolvedAt, input.approvalId],
      )
      return approvalFromRow({
        ...existing,
        status: input.status,
        resolved_at: resolvedAt,
      })
    })
  }

  pendingApprovals(sessionId: string): ApprovalRecord[] {
    assertNonEmpty(sessionId, "Session id")
    return this.#database
      .read((connection) =>
        connection.all<ApprovalRow>(
          `SELECT id, session_id, run_id, tool_name, redacted_summary,
                  dedupe_key, status, created_at, resolved_at
           FROM approval
           WHERE session_id = ? AND status = 'pending'
           ORDER BY created_at, id`,
          [sessionId],
        ),
      )
      .map(approvalFromRow)
  }

  getProjectionCursor(sessionId: string): ProjectionCursor | undefined {
    assertNonEmpty(sessionId, "Session id")
    const row = this.#database.read((connection) =>
      loadProjection(connection, sessionId),
    )
    return row ? projectionFromRow(row) : undefined
  }

  advanceProjectionCursor(
    input: AdvanceProjectionCursorInput,
  ): ProjectionCursor {
    assertNonEmpty(input.sessionId, "Session id")
    assertNonEmpty(input.checksum, "Projection checksum")
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new Error("Projection sequence must be a non-negative safe integer")
    }

    return this.#database.transaction((connection) => {
      const existing = loadProjection(connection, input.sessionId)
      if (existing) {
        if (input.sequence < existing.sequence) {
          throw new RuntimeConflictError(
            "projection_conflict",
            `Projection cursor cannot move backwards from ${existing.sequence} to ${input.sequence}`,
          )
        }
        if (input.sequence === existing.sequence) {
          if (input.checksum !== existing.checksum) {
            throw new RuntimeConflictError(
              "projection_conflict",
              `Projection checksum diverged at sequence ${input.sequence}`,
            )
          }
          return projectionFromRow(existing)
        }
        if (input.expectedPreviousChecksum !== existing.checksum) {
          throw new RuntimeConflictError(
            "projection_conflict",
            "Projection parent checksum does not match the stored cursor",
          )
        }
      } else if (input.expectedPreviousChecksum !== undefined) {
        throw new RuntimeConflictError(
          "projection_conflict",
          "Projection has no stored cursor for the expected parent checksum",
        )
      }

      const updatedAt = this.#now()
      connection.run(
        `INSERT INTO rollout_projection
          (session_id, sequence, checksum, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           sequence = excluded.sequence,
           checksum = excluded.checksum,
           updated_at = excluded.updated_at`,
        [input.sessionId, input.sequence, input.checksum, updatedAt],
      )
      return {
        sessionId: input.sessionId,
        sequence: input.sequence,
        checksum: input.checksum,
        updatedAt,
      }
    })
  }
}
