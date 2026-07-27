import { randomUUID } from "node:crypto"

import type { NexusStateDatabase } from "./database.js"
import type { StateConnection, StateReadConnection } from "./schema.js"
import {
  allocateRuntimeInputSequence,
  appendProtocolEvent,
  assertEpochs,
  assertRuntimeIdentifier,
  canonicalJson,
  checksumJson,
  inputFromRow,
  loadActiveTurn,
  loadProtocolEvents,
  loadRuntimeInput,
  monotonicRuntimeTimestamp,
  normalizeExecution,
  normalizeRuntimeParts,
  readRuntimeTimestamp,
  requireLiveRuntimeFence,
  turnFromRows,
  type RuntimeInputRow,
  type RuntimeTurnRow,
} from "./session-runtime-sql.js"
import {
  SessionRuntimeConflictError,
  type RuntimeAdmittedInput,
  type RuntimeCommandReceipt,
  type RuntimeDurableTurn,
  type RuntimeEpochSnapshot,
  type RuntimeExecutionSnapshot,
  type RuntimeInputPart,
  type RuntimeOwnershipFence,
  type RuntimeProtocolEnvelope,
  type RuntimeReplayWindow,
  type RuntimeSessionCommand,
  type RuntimeSessionMode,
  type RuntimeSessionPhase,
  type RuntimeSessionProtocolSnapshot,
  type RuntimeSessionSnapshot,
  type RuntimeTurnResult,
  type SessionRuntimeRepositoryOptions,
} from "./session-runtime-types.js"

type CommandRow = {
  command_id: string
  session_id: string
  command_type: string
  fingerprint: string
  receipt_json: string
  created_at: number
}

type ApprovalRow = {
  id: string
  session_id: string
  run_id: string | null
  tool_name: string
  redacted_summary: string
  dedupe_key: string
  status: "pending" | "approved" | "denied" | "cancelled"
  created_at: number
  resolved_at: number | null
}

type PendingApprovalSnapshotRow = {
  approval_id: string
  turn_id: string
  tool_name: string
  redacted_summary: string
}

type PendingNextModeRow = {
  session_id: string
  requested_by_turn_id: string
  mode: RuntimeSessionMode
  created_at: number
}

const RUNNER_PHASES = new Set([
  "preparing",
  "streaming",
  "waiting_approval",
  "executing_tools",
  "compacting",
  "settling",
])

const PHASE_TRANSITIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  preparing: new Set([
    "streaming",
    "waiting_approval",
    "executing_tools",
    "compacting",
    "settling",
  ]),
  streaming: new Set([
    "waiting_approval",
    "executing_tools",
    "compacting",
    "settling",
  ]),
  waiting_approval: new Set([
    "streaming",
    "executing_tools",
    "compacting",
    "settling",
  ]),
  executing_tools: new Set([
    "streaming",
    "waiting_approval",
    "compacting",
    "settling",
  ]),
  compacting: new Set(["streaming", "settling"]),
  settling: new Set(),
}

function parseStoredJson<T>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T
  } catch {
    throw new Error(`Stored ${label} is not valid JSON`)
  }
}

function assertSafeSequence(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${label} must be a safe integer of at least ${minimum}`)
  }
}

function statusForRun(result: RuntimeTurnResult):
  | "completed"
  | "failed"
  | "interrupted" {
  return result.status
}

export class SessionRuntimeRepository {
  readonly #database: NexusStateDatabase
  readonly #now: () => number
  readonly #createId: (kind: "turn" | "run" | "event") => string

  constructor(
    database: NexusStateDatabase,
    options: SessionRuntimeRepositoryOptions = {},
  ) {
    this.#database = database
    this.#now = options.now ?? Date.now
    this.#createId =
      options.createId ?? ((kind) => `${kind}-${randomUUID()}`)
  }

  ensureWorkspaceSession(input: {
    workspaceId: string
    canonicalPath: string
    sessionId: string
  }): void {
    assertRuntimeIdentifier(input.workspaceId, "Workspace id")
    assertRuntimeIdentifier(input.sessionId, "Session id")
    if (
      typeof input.canonicalPath !== "string" ||
      input.canonicalPath.length === 0 ||
      input.canonicalPath.includes("\0")
    ) {
      throw new Error("Canonical workspace path must be a non-empty safe path")
    }
    const timestamp = readRuntimeTimestamp(this.#now)
    this.#database.transaction((connection) => {
      const workspace = connection.get<{
        id: string
        canonical_path: string
      }>(
        `SELECT id, canonical_path
         FROM workspace
         WHERE id = ? OR canonical_path = ?`,
        [input.workspaceId, input.canonicalPath],
      )
      if (
        workspace &&
        (workspace.id !== input.workspaceId ||
          workspace.canonical_path !== input.canonicalPath)
      ) {
        throw new Error(
          "Workspace identity conflicts with an existing canonical path",
        )
      }
      if (!workspace) {
        connection.run(
          `INSERT INTO workspace
            (id, canonical_path, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          [
            input.workspaceId,
            input.canonicalPath,
            timestamp,
            timestamp,
          ],
        )
      }
      const session = connection.get<{
        workspace_id: string
        archived_at: number | null
      }>(
        `SELECT workspace_id, archived_at FROM session WHERE id = ?`,
        [input.sessionId],
      )
      if (session && session.workspace_id !== input.workspaceId) {
        throw new Error(
          `Session ${input.sessionId} belongs to another workspace`,
        )
      }
      if (session?.archived_at !== null && session?.archived_at !== undefined) {
        throw new SessionRuntimeConflictError(
          "session_deleted",
          `Session ${input.sessionId} was deleted`,
        )
      }
      if (!session) {
        connection.run(
          `INSERT INTO session
            (id, workspace_id, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          [input.sessionId, input.workspaceId, timestamp, timestamp],
        )
      }
    })
  }

  isSessionTombstoned(sessionId: string): boolean {
    assertRuntimeIdentifier(sessionId, "Session id")
    return this.#database.read((connection) => {
      const session = connection.get<{ archived_at: number | null }>(
        `SELECT archived_at FROM session WHERE id = ?`,
        [sessionId],
      )
      return session?.archived_at !== null &&
        session?.archived_at !== undefined
    })
  }

  /**
   * Transactionally closes protocol-v2 admission for an idle session.
   *
   * JSONL deletion happens after this tombstone commits. If that filesystem
   * step fails, a retry sees `tombstoned: false` and can safely finish the
   * portable-history cleanup without ever accepting new work in between.
   */
  tombstoneSession(input: {
    sessionId: string
    fence: RuntimeOwnershipFence
  }): { tombstoned: boolean } {
    assertRuntimeIdentifier(input.sessionId, "Session id")
    return this.#database.transaction((connection) => {
      const session = connection.get<{ archived_at: number | null }>(
        `SELECT archived_at FROM session WHERE id = ?`,
        [input.sessionId],
      )
      if (!session) {
        throw new SessionRuntimeConflictError(
          "session_deleted",
          `Session ${input.sessionId} does not exist`,
        )
      }
      if (session.archived_at !== null) {
        return { tombstoned: false }
      }

      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        input.sessionId,
        input.fence,
        observedAt,
      )
      const hasActiveTurn = connection.get<{ present: number }>(
        `SELECT 1 AS present
         FROM session_turn
         WHERE session_id = ? AND result_status IS NULL
         LIMIT 1`,
        [input.sessionId],
      )
      const hasPendingInput = connection.get<{ present: number }>(
        `SELECT 1 AS present
         FROM runtime_session_input
         WHERE session_id = ? AND promoted_sequence IS NULL
         LIMIT 1`,
        [input.sessionId],
      )
      const hasPendingApproval = connection.get<{ present: number }>(
        `SELECT 1 AS present
         FROM approval
         WHERE session_id = ? AND status = 'pending'
         LIMIT 1`,
        [input.sessionId],
      )
      const hasRunningRun = connection.get<{ present: number }>(
        `SELECT 1 AS present
         FROM run
         WHERE session_id = ? AND status = 'running'
         LIMIT 1`,
        [input.sessionId],
      )
      if (
        hasActiveTurn ||
        hasPendingInput ||
        hasPendingApproval ||
        hasRunningRun
      ) {
        throw new SessionRuntimeConflictError(
          "session_not_idle",
          `Session ${input.sessionId} still has accepted or active work`,
        )
      }

      const archivedAt = monotonicRuntimeTimestamp(
        connection,
        input.sessionId,
        this.#now,
        lease.updated_at,
      )
      const updated = connection.run(
        `UPDATE session
         SET archived_at = ?, updated_at = ?
         WHERE id = ? AND archived_at IS NULL`,
        [archivedAt, archivedAt, input.sessionId],
      )
      if (Number(updated.changes) !== 1) {
        throw new SessionRuntimeConflictError(
          "session_deleted",
          `Session ${input.sessionId} was deleted concurrently`,
        )
      }
      return { tombstoned: true }
    })
  }

  prepareCommand(input: {
    command: RuntimeSessionCommand
    fence: RuntimeOwnershipFence
  }): RuntimeCommandReceipt {
    const command = this.#normalizeCommand(input.command)
    const fingerprint = checksumJson(command)
    return this.#database.transaction((connection) => {
      const existing = connection.get<CommandRow>(
        `SELECT command_id, session_id, command_type, fingerprint,
                receipt_json, created_at
         FROM session_command
         WHERE command_id = ?`,
        [command.commandId],
      )
      if (existing) {
        if (
          existing.session_id !== command.sessionId ||
          existing.command_type !== command.type ||
          existing.fingerprint !== fingerprint
        ) {
          throw new SessionRuntimeConflictError(
            "idempotency_conflict",
            `Command id ${command.commandId} was already used for different content`,
          )
        }
        return parseStoredJson<RuntimeCommandReceipt>(
          existing.receipt_json,
          "command receipt",
        )
      }

      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        command.sessionId,
        input.fence,
        observedAt,
      )
      const createdAt = monotonicRuntimeTimestamp(
        connection,
        command.sessionId,
        this.#now,
        lease.updated_at,
      )
      const base = {
        version: 2 as const,
        commandId: command.commandId,
        sessionId: command.sessionId,
        accepted: true as const,
      }
      let receipt: RuntimeCommandReceipt

      if (command.type === "start_turn" || command.type === "queue_turn") {
        const execution = normalizeExecution({
          mode: command.mode,
          ...(command.selection === undefined
            ? {}
            : { selection: command.selection }),
        })
        const admitted = this.#admitInput(
          connection,
          {
            inputId: command.inputId,
            sessionId: command.sessionId,
            delivery: "queue",
            parts: command.input,
            execution,
            fence: input.fence,
          },
          createdAt,
        )
        if (command.type === "start_turn") {
          const oldest = connection.get<{ id: string }>(
            `SELECT id
             FROM runtime_session_input
             WHERE session_id = ?
               AND delivery = 'queue'
               AND promoted_sequence IS NULL
             ORDER BY admitted_sequence
             LIMIT 1`,
            [command.sessionId],
          )
          receipt = {
            ...base,
            type: "start_turn",
            inputId: admitted.id,
            turnId: admitted.reservedTurnId,
            runId: admitted.reservedRunId,
            started:
              loadActiveTurn(connection, command.sessionId) === undefined &&
              oldest?.id === admitted.id,
          }
        } else {
          receipt = {
            ...base,
            type: "queue_turn",
            inputId: admitted.id,
            turnId: admitted.reservedTurnId,
            runId: admitted.reservedRunId,
          }
        }
      } else if (command.type === "steer_turn") {
        const active = this.#requireActive(
          connection,
          command.sessionId,
          command.expectedTurnId,
        )
        const execution = normalizeExecution(
          parseStoredJson<RuntimeExecutionSnapshot>(
            active.execution_json,
            "active turn execution",
          ),
        )
        const admitted = this.#admitInput(
          connection,
          {
            inputId: command.inputId,
            sessionId: command.sessionId,
            delivery: "steer",
            expectedTurnId: command.expectedTurnId,
            parts: command.input,
            execution,
            fence: input.fence,
          },
          createdAt,
        )
        receipt = {
          ...base,
          type: "steer_turn",
          inputId: admitted.id,
          expectedTurnId: command.expectedTurnId,
          reservedTurnId: admitted.reservedTurnId,
          reservedRunId: admitted.reservedRunId,
        }
      } else if (command.type === "interrupt_turn") {
        const active = loadActiveTurn(connection, command.sessionId)
        if (
          active &&
          active.id !== command.expectedTurnId
        ) {
          throw new SessionRuntimeConflictError(
            "turn_conflict",
            `Expected active turn ${command.expectedTurnId}, found ${active.id}`,
          )
        }
        if (active) {
          this.#requestInterrupt(
            connection,
            active,
            input.fence,
            command.reason,
            createdAt,
          )
        }
        receipt = {
          ...base,
          type: "interrupt_turn",
          expectedTurnId: command.expectedTurnId,
          interrupted: active !== undefined,
        }
      } else {
        const active = this.#requireActive(
          connection,
          command.sessionId,
          command.expectedTurnId,
        )
        this.#resolveApproval(
          connection,
          {
            sessionId: command.sessionId,
            approvalId: command.approvalId,
            expectedTurnId: command.expectedTurnId,
            status: command.status,
            fence: input.fence,
          },
          active,
          createdAt,
        )
        receipt = {
          ...base,
          type: "resolve_approval",
          approvalId: command.approvalId,
          expectedTurnId: command.expectedTurnId,
          status: command.status,
        }
      }

      connection.run(
        `INSERT INTO session_command
          (command_id, session_id, command_type, fingerprint,
           receipt_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          command.commandId,
          command.sessionId,
          command.type,
          fingerprint,
          canonicalJson(receipt),
          createdAt,
        ],
      )
      return receipt
    })
  }

  admitInput(input: {
    inputId: string
    sessionId: string
    fence: RuntimeOwnershipFence
    delivery: "steer" | "queue"
    expectedTurnId?: string
    parts: readonly RuntimeInputPart[]
    execution: RuntimeExecutionSnapshot
  }): RuntimeAdmittedInput {
    return this.#database.transaction((connection) => {
      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        input.sessionId,
        input.fence,
        observedAt,
      )
      const createdAt = monotonicRuntimeTimestamp(
        connection,
        input.sessionId,
        this.#now,
        lease.updated_at,
      )
      return this.#admitInput(connection, input, createdAt)
    })
  }

  pendingSteers(
    sessionId: string,
    turnId: string,
  ): readonly RuntimeAdmittedInput[] {
    assertRuntimeIdentifier(sessionId, "Session id")
    assertRuntimeIdentifier(turnId, "Turn id")
    return this.#database
      .read((connection) =>
        connection.all<RuntimeInputRow>(
          `SELECT id, session_id, delivery, admitted_sequence,
                  promoted_sequence, expected_turn_id, reserved_turn_id,
                  reserved_run_id, payload_checksum, parts_json,
                  execution_json, created_at, requeued_from_turn_id
           FROM runtime_session_input
           WHERE session_id = ?
             AND delivery = 'steer'
             AND expected_turn_id = ?
             AND promoted_sequence IS NULL
           ORDER BY admitted_sequence`,
          [sessionId, turnId],
        ),
      )
      .map(inputFromRow)
  }

  promoteSteers(
    sessionId: string,
    turnId: string,
    cutoff: number,
    fence: RuntimeOwnershipFence,
  ): readonly RuntimeAdmittedInput[] {
    assertSafeSequence(cutoff, "Steering cutoff")
    return this.#database.transaction((connection) => {
      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        sessionId,
        fence,
        observedAt,
      )
      const active = this.#requireActive(connection, sessionId, turnId)
      const rows = connection.all<RuntimeInputRow>(
        `SELECT id, session_id, delivery, admitted_sequence,
                promoted_sequence, expected_turn_id, reserved_turn_id,
                reserved_run_id, payload_checksum, parts_json,
                execution_json, created_at, requeued_from_turn_id
         FROM runtime_session_input
         WHERE session_id = ?
           AND delivery = 'steer'
           AND expected_turn_id = ?
           AND promoted_sequence IS NULL
           AND admitted_sequence <= ?
         ORDER BY admitted_sequence`,
        [sessionId, turnId, cutoff],
      )
      const promoted = rows.map((row) => {
        const promotedSequence = allocateRuntimeInputSequence(
          connection,
          sessionId,
        )
        connection.run(
          `UPDATE runtime_session_input
           SET promoted_sequence = ?
           WHERE id = ? AND promoted_sequence IS NULL`,
          [promotedSequence, row.id],
        )
        return inputFromRow({
          ...row,
          promoted_sequence: promotedSequence,
        })
      })
      if (promoted.length > 0) {
        const emittedAt = monotonicRuntimeTimestamp(
          connection,
          sessionId,
          this.#now,
          lease.updated_at,
          active.updated_at,
        )
        appendProtocolEvent(connection, {
          sessionId,
          turnId,
          runId: active.run_id,
          emittedAt,
          createEventId: () => this.#id("event"),
          payload: {
            type: "steering_promoted",
            inputIds: promoted.map((item) => item.id),
          },
        })
      }
      return promoted
    })
  }

  requestNextMode(input: {
    sessionId: string
    expectedTurnId: string
    mode: RuntimeSessionMode
    fence: RuntimeOwnershipFence
  }): void {
    assertRuntimeIdentifier(input.sessionId, "Session id")
    assertRuntimeIdentifier(input.expectedTurnId, "Expected turn id")
    const mode = normalizeExecution({ mode: input.mode }).mode
    this.#database.transaction((connection) => {
      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        input.sessionId,
        input.fence,
        observedAt,
      )
      const active = this.#requireActive(
        connection,
        input.sessionId,
        input.expectedTurnId,
      )
      this.#assertTurnFence(active, input.fence)
      const existing = connection.get<PendingNextModeRow>(
        `SELECT session_id, requested_by_turn_id, mode, created_at
         FROM session_next_mode
         WHERE session_id = ?`,
        [input.sessionId],
      )
      if (existing) {
        if (
          existing.requested_by_turn_id === input.expectedTurnId &&
          existing.mode === mode
        ) {
          return
        }
        throw new SessionRuntimeConflictError(
          "turn_conflict",
          `Session ${input.sessionId} already has a different pending mode transition`,
        )
      }
      const createdAt = monotonicRuntimeTimestamp(
        connection,
        input.sessionId,
        this.#now,
        lease.updated_at,
        active.updated_at,
      )
      connection.run(
        `INSERT INTO session_next_mode
          (session_id, requested_by_turn_id, mode, created_at)
         VALUES (?, ?, ?, ?)`,
        [input.sessionId, input.expectedTurnId, mode, createdAt],
      )
    })
  }

  claimNextTurn(input: {
    sessionId: string
    epochs: RuntimeEpochSnapshot
    fence: RuntimeOwnershipFence
  }): RuntimeDurableTurn | undefined {
    assertEpochs(input.epochs)
    return this.#database.transaction((connection) => {
      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        input.sessionId,
        input.fence,
        observedAt,
      )
      if (loadActiveTurn(connection, input.sessionId)) return undefined
      const queued = connection.get<RuntimeInputRow>(
        `SELECT id, session_id, delivery, admitted_sequence,
                promoted_sequence, expected_turn_id, reserved_turn_id,
                reserved_run_id, payload_checksum, parts_json,
                execution_json, created_at, requeued_from_turn_id
         FROM runtime_session_input
         WHERE session_id = ?
           AND delivery = 'queue'
           AND promoted_sequence IS NULL
         ORDER BY admitted_sequence
         LIMIT 1`,
        [input.sessionId],
      )
      if (!queued) return undefined
      const queuedExecution = normalizeExecution(
        parseStoredJson<RuntimeExecutionSnapshot>(
          queued.execution_json,
          "queued execution",
        ),
      )
      const pendingNextMode = connection.get<PendingNextModeRow>(
        `SELECT session_id, requested_by_turn_id, mode, created_at
         FROM session_next_mode
         WHERE session_id = ?`,
        [input.sessionId],
      )
      const turnExecution = pendingNextMode
        ? normalizeExecution({
            ...queuedExecution,
            mode: pendingNextMode.mode,
          })
        : queuedExecution

      const promotedSequence = allocateRuntimeInputSequence(
        connection,
        input.sessionId,
      )
      const promoted = connection.run(
        `UPDATE runtime_session_input
         SET promoted_sequence = ?
         WHERE id = ? AND promoted_sequence IS NULL`,
        [promotedSequence, queued.id],
      )
      if (Number(promoted.changes) !== 1) {
        throw new SessionRuntimeConflictError(
          "turn_conflict",
          `Input ${queued.id} was claimed concurrently`,
        )
      }
      const timestamp = monotonicRuntimeTimestamp(
        connection,
        input.sessionId,
        this.#now,
        lease.updated_at,
        queued.created_at,
      )
      connection.run(
        `INSERT INTO run
          (id, session_id, owner_id, lease_epoch, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
        [
          queued.reserved_run_id,
          input.sessionId,
          input.fence.ownerId,
          input.fence.leaseEpoch,
          timestamp,
        ],
      )
      connection.run(
        `INSERT INTO session_turn
          (id, session_id, run_id, input_id, phase, execution_json,
           config_epoch, context_epoch, owner_id, lease_epoch,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?, ?)`,
        [
          queued.reserved_turn_id,
          input.sessionId,
          queued.reserved_run_id,
          queued.id,
          canonicalJson(turnExecution),
          input.epochs.configEpoch,
          input.epochs.contextEpoch,
          input.fence.ownerId,
          input.fence.leaseEpoch,
          timestamp,
          timestamp,
        ],
      )
      appendProtocolEvent(connection, {
        sessionId: input.sessionId,
        turnId: queued.reserved_turn_id,
        runId: queued.reserved_run_id,
        emittedAt: timestamp,
        createEventId: () => this.#id("event"),
        payload: {
          type: "turn_started",
          turnId: queued.reserved_turn_id,
          runId: queued.reserved_run_id,
          configEpoch: input.epochs.configEpoch,
          contextEpoch: input.epochs.contextEpoch,
          execution: turnExecution,
        },
      })
      if (pendingNextMode) {
        const consumed = connection.run(
          `DELETE FROM session_next_mode
           WHERE session_id = ? AND requested_by_turn_id = ?`,
          [input.sessionId, pendingNextMode.requested_by_turn_id],
        )
        if (Number(consumed.changes) !== 1) {
          throw new SessionRuntimeConflictError(
            "turn_conflict",
            `Pending mode transition for ${input.sessionId} changed concurrently`,
          )
        }
      }
      const turn = loadActiveTurn(connection, input.sessionId)
      const storedInput = loadRuntimeInput(connection, queued.id)
      if (!turn || !storedInput) {
        throw new Error("Claimed turn could not be read back")
      }
      return turnFromRows(
        turn,
        storedInput,
        pendingNextMode
          ? { requestedByTurnId: pendingNextMode.requested_by_turn_id }
          : undefined,
      )
    })
  }

  setPhase(input: {
    sessionId: string
    turnId: string
    phase: RuntimeSessionPhase
    fence: RuntimeOwnershipFence
  }): void {
    if (!RUNNER_PHASES.has(input.phase)) {
      throw new SessionRuntimeConflictError(
        "invalid_phase",
        `Runner cannot enter terminal phase ${input.phase}`,
      )
    }
    this.#database.transaction((connection) => {
      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        input.sessionId,
        input.fence,
        observedAt,
      )
      const active = this.#requireActive(
        connection,
        input.sessionId,
        input.turnId,
      )
      this.#assertTurnFence(active, input.fence)
      if (active.phase === input.phase) return
      if (!PHASE_TRANSITIONS[active.phase]?.has(input.phase)) {
        throw new SessionRuntimeConflictError(
          "invalid_phase",
          `Cannot transition turn ${input.turnId} from ${active.phase} to ${input.phase}`,
        )
      }
      const updatedAt = monotonicRuntimeTimestamp(
        connection,
        input.sessionId,
        this.#now,
        lease.updated_at,
        active.updated_at,
      )
      connection.run(
        `UPDATE session_turn
         SET phase = ?, updated_at = ?
         WHERE id = ? AND result_status IS NULL
           AND owner_id = ? AND lease_epoch = ?`,
        [
          input.phase,
          updatedAt,
          input.turnId,
          input.fence.ownerId,
          input.fence.leaseEpoch,
        ],
      )
      appendProtocolEvent(connection, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: active.run_id,
        emittedAt: updatedAt,
        createEventId: () => this.#id("event"),
        payload: { type: "phase_changed", phase: input.phase },
      })
    })
  }

  requestInterrupt(input: {
    sessionId: string
    turnId: string
    reason?: string
    fence: RuntimeOwnershipFence
  }): void {
    this.#database.transaction((connection) => {
      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        input.sessionId,
        input.fence,
        observedAt,
      )
      const active = this.#requireActive(
        connection,
        input.sessionId,
        input.turnId,
      )
      this.#requestInterrupt(
        connection,
        active,
        input.fence,
        input.reason,
        monotonicRuntimeTimestamp(
          connection,
          input.sessionId,
          this.#now,
          lease.updated_at,
          active.updated_at,
        ),
      )
    })
  }

  finishTurn(input: {
    sessionId: string
    turnId: string
    result: RuntimeTurnResult
    fence: RuntimeOwnershipFence
  }): { requeuedInputs: readonly RuntimeAdmittedInput[] } {
    return this.#database.transaction((connection) =>
      this.#finishTurn(connection, input, false),
    )
  }

  forceInterrupt(input: {
    sessionId: string
    turnId: string
    reason: string
    fence: RuntimeOwnershipFence
  }): { requeuedInputs: readonly RuntimeAdmittedInput[] } {
    return this.#database.transaction((connection) =>
      this.#finishTurn(
        connection,
        {
          sessionId: input.sessionId,
          turnId: input.turnId,
          result: { status: "interrupted", error: input.reason },
          fence: input.fence,
        },
        false,
      ),
    )
  }

  createApproval(input: {
    approvalId: string
    sessionId: string
    expectedTurnId: string
    toolName: string
    redactedSummary: string
    dedupeKey: string
    fence: RuntimeOwnershipFence
  }): void {
    assertRuntimeIdentifier(input.approvalId, "Approval id")
    if (
      !input.toolName.trim() ||
      input.toolName.length > 256 ||
      !input.redactedSummary.trim() ||
      input.redactedSummary.length > 20_000 ||
      !input.dedupeKey.trim() ||
      input.dedupeKey.length > 512
    ) {
      throw new Error("Approval metadata is empty or exceeds its limit")
    }
    this.#database.transaction((connection) => {
      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        input.sessionId,
        input.fence,
        observedAt,
      )
      const active = this.#requireActive(
        connection,
        input.sessionId,
        input.expectedTurnId,
      )
      this.#assertTurnFence(active, input.fence)
      const existing = this.#loadApproval(connection, input.approvalId)
      if (existing) {
        const same =
          existing.session_id === input.sessionId &&
          existing.run_id === active.run_id &&
          existing.tool_name === input.toolName &&
          existing.redacted_summary === input.redactedSummary &&
          existing.dedupe_key === input.dedupeKey
        if (same) return
        throw new SessionRuntimeConflictError(
          "approval_conflict",
          `Approval ${input.approvalId} already exists with different content`,
        )
      }
      const createdAt = monotonicRuntimeTimestamp(
        connection,
        input.sessionId,
        this.#now,
        lease.updated_at,
        active.updated_at,
      )
      connection.run(
        `INSERT INTO approval
          (id, session_id, run_id, tool_name, redacted_summary,
           dedupe_key, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [
          input.approvalId,
          input.sessionId,
          active.run_id,
          input.toolName,
          input.redactedSummary,
          input.dedupeKey,
          createdAt,
        ],
      )
      appendProtocolEvent(connection, {
        sessionId: input.sessionId,
        turnId: active.id,
        runId: active.run_id,
        emittedAt: createdAt,
        createEventId: () => this.#id("event"),
        payload: {
          type: "approval_requested",
          approvalId: input.approvalId,
          toolName: input.toolName,
          redactedSummary: input.redactedSummary,
        },
      })
    })
  }

  resolveApproval(input: {
    sessionId: string
    approvalId: string
    expectedTurnId: string
    status: "approved" | "denied"
    fence: RuntimeOwnershipFence
  }): void {
    this.#database.transaction((connection) => {
      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        input.sessionId,
        input.fence,
        observedAt,
      )
      const active = this.#requireActive(
        connection,
        input.sessionId,
        input.expectedTurnId,
      )
      this.#resolveApproval(
        connection,
        input,
        active,
        monotonicRuntimeTimestamp(
          connection,
          input.sessionId,
          this.#now,
          lease.updated_at,
          active.updated_at,
        ),
      )
    })
  }

  approvalResolution(input: {
    sessionId: string
    approvalId: string
  }):
    | {
        expectedTurnId: string
        status: "approved" | "denied"
      }
    | undefined {
    assertRuntimeIdentifier(input.sessionId, "Session id")
    assertRuntimeIdentifier(input.approvalId, "Approval id")
    return this.#database.read((connection) => {
      const row = connection.get<{
        turn_id: string
        status: string
      }>(
        `SELECT session_turn.id AS turn_id, approval.status AS status
         FROM approval
         JOIN session_turn ON session_turn.run_id = approval.run_id
         WHERE approval.id = ? AND approval.session_id = ?`,
        [input.approvalId, input.sessionId],
      )
      if (
        !row ||
        (row.status !== "approved" && row.status !== "denied")
      ) {
        return undefined
      }
      return {
        expectedTurnId: row.turn_id,
        status: row.status,
      }
    })
  }

  snapshot(sessionId: string): RuntimeSessionSnapshot {
    assertRuntimeIdentifier(sessionId, "Session id")
    return this.#database.read((connection) =>
      this.#snapshot(connection, sessionId),
    )
  }

  recoverSession(input: {
    sessionId: string
    fence: RuntimeOwnershipFence
  }): {
    snapshot: RuntimeSessionSnapshot
    interruptedTurn?: {
      turnId: string
      runId: string
      result: { status: "interrupted"; error: string }
      requeuedInputs: readonly RuntimeAdmittedInput[]
    }
  } {
    return this.#database.transaction((connection) => {
      const observedAt = readRuntimeTimestamp(this.#now)
      requireLiveRuntimeFence(
        connection,
        input.sessionId,
        input.fence,
        observedAt,
      )
      const active = loadActiveTurn(connection, input.sessionId)
      if (!active) {
        return { snapshot: this.#snapshot(connection, input.sessionId) }
      }
      const result = {
        status: "interrupted" as const,
        error: "Recovered an ambiguous in-progress turn",
      }
      const commit = this.#finishTurn(
        connection,
        {
          sessionId: input.sessionId,
          turnId: active.id,
          result,
          fence: input.fence,
        },
        true,
      )
      return {
        snapshot: this.#snapshot(connection, input.sessionId),
        interruptedTurn: {
          turnId: active.id,
          runId: active.run_id,
          result,
          requeuedInputs: commit.requeuedInputs,
        },
      }
    })
  }

  appendAgentEvent(input: {
    sessionId: string
    turnId: string
    runId: string
    event: Readonly<Record<string, unknown>>
    fence: RuntimeOwnershipFence
  }): RuntimeProtocolEnvelope {
    const serialized = canonicalJson(input.event)
    if (serialized.length > 256 * 1024) {
      throw new Error("Agent event exceeds the 262144-character limit")
    }
    return this.#database.transaction((connection) => {
      const observedAt = readRuntimeTimestamp(this.#now)
      const lease = requireLiveRuntimeFence(
        connection,
        input.sessionId,
        input.fence,
        observedAt,
      )
      const active = this.#requireActive(
        connection,
        input.sessionId,
        input.turnId,
      )
      this.#assertTurnFence(active, input.fence)
      if (active.run_id !== input.runId) {
        throw new SessionRuntimeConflictError(
          "turn_conflict",
          `Run ${input.runId} does not belong to turn ${input.turnId}`,
        )
      }
      return appendProtocolEvent(connection, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: input.runId,
        emittedAt: monotonicRuntimeTimestamp(
          connection,
          input.sessionId,
          this.#now,
          lease.updated_at,
          active.updated_at,
        ),
        createEventId: () => this.#id("event"),
        payload: {
          type: "agent_event",
          event: parseStoredJson<Record<string, unknown>>(
            serialized,
            "agent event",
          ),
        },
      })
    })
  }

  events(
    sessionId: string,
    afterSequence: number,
    limit = 2048,
  ): readonly RuntimeProtocolEnvelope[] {
    assertRuntimeIdentifier(sessionId, "Session id")
    assertSafeSequence(afterSequence, "Replay sequence")
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("Replay limit must be from 1 through 10000")
    }
    return this.#database.read((connection) =>
      loadProtocolEvents(connection, sessionId, afterSequence, limit),
    )
  }

  replayWindow(sessionId: string): RuntimeReplayWindow {
    assertRuntimeIdentifier(sessionId, "Session id")
    return this.#database.read((connection) =>
      this.#replayWindow(connection, sessionId),
    )
  }

  protocolSnapshot(sessionId: string): RuntimeSessionProtocolSnapshot {
    assertRuntimeIdentifier(sessionId, "Session id")
    return this.#database.read((connection) => {
      const runtime = this.#snapshot(connection, sessionId)
      const replay = this.#replayWindow(connection, sessionId)
      if (!runtime.activeTurn) return { runtime, ...replay }
      const first = connection.get<{ sequence: number | null }>(
        `SELECT MIN(sequence) AS sequence
         FROM protocol_event
         WHERE session_id = ? AND turn_id = ? AND run_id = ?`,
        [
          sessionId,
          runtime.activeTurn.turnId,
          runtime.activeTurn.runId,
        ],
      )?.sequence
      if (
        first === null ||
        first === undefined ||
        !Number.isSafeInteger(first) ||
        first < replay.earliestAvailableSequence ||
        first > replay.throughSequence
      ) {
        throw new Error(
          `Active turn ${runtime.activeTurn.turnId} has no contiguous replay origin`,
        )
      }
      return {
        runtime,
        activeTurnFirstSequence: first,
        ...replay,
      }
    })
  }

  #normalizeCommand(command: RuntimeSessionCommand): RuntimeSessionCommand {
    if (!command || typeof command !== "object" || command.version !== 2) {
      throw new Error("Session command requires protocol version 2")
    }
    assertRuntimeIdentifier(command.commandId, "Command id")
    assertRuntimeIdentifier(command.sessionId, "Session id")
    if (command.type === "start_turn" || command.type === "queue_turn") {
      assertRuntimeIdentifier(command.inputId, "Input id")
      const execution = normalizeExecution({
        mode: command.mode,
        ...(command.selection === undefined
          ? {}
          : { selection: command.selection }),
      })
      return Object.freeze({
        ...command,
        input: normalizeRuntimeParts(command.input),
        mode: execution.mode,
        ...(execution.selection === undefined
          ? {}
          : { selection: execution.selection }),
      })
    }
    if (command.type === "steer_turn") {
      assertRuntimeIdentifier(command.inputId, "Input id")
      assertRuntimeIdentifier(command.expectedTurnId, "Expected turn id")
      return Object.freeze({
        ...command,
        input: normalizeRuntimeParts(command.input),
      })
    }
    assertRuntimeIdentifier(command.expectedTurnId, "Expected turn id")
    if (command.type === "interrupt_turn") {
      if (
        command.reason !== undefined &&
        (!command.reason.trim() || command.reason.length > 2000)
      ) {
        throw new Error("Interrupt reason is empty or exceeds 2000 characters")
      }
      return Object.freeze({ ...command })
    }
    assertRuntimeIdentifier(command.approvalId, "Approval id")
    if (command.status !== "approved" && command.status !== "denied") {
      throw new Error("Approval status must be approved or denied")
    }
    return Object.freeze({ ...command })
  }

  #admitInput(
    connection: StateConnection,
    input: {
      inputId: string
      sessionId: string
      fence: RuntimeOwnershipFence
      delivery: "steer" | "queue"
      expectedTurnId?: string
      parts: readonly RuntimeInputPart[]
      execution: RuntimeExecutionSnapshot
    },
    createdAt: number,
  ): RuntimeAdmittedInput {
    assertRuntimeIdentifier(input.inputId, "Input id")
    assertRuntimeIdentifier(input.sessionId, "Session id")
    const parts = normalizeRuntimeParts(input.parts)
    const execution = normalizeExecution(input.execution)
    if (
      (input.delivery === "steer") !==
      (input.expectedTurnId !== undefined)
    ) {
      throw new Error(
        "Only steering input requires an expected active turn identity",
      )
    }
    if (input.expectedTurnId !== undefined) {
      assertRuntimeIdentifier(input.expectedTurnId, "Expected turn id")
      const active = this.#requireActive(
        connection,
        input.sessionId,
        input.expectedTurnId,
      )
      this.#assertTurnFence(active, input.fence)
      const activeExecution = normalizeExecution(
        parseStoredJson<RuntimeExecutionSnapshot>(
          active.execution_json,
          "active execution snapshot",
        ),
      )
      if (canonicalJson(activeExecution) !== canonicalJson(execution)) {
        throw new SessionRuntimeConflictError(
          "turn_conflict",
          "Steering input must inherit the active turn execution snapshot",
        )
      }
    }
    const fingerprint = checksumJson({
      inputId: input.inputId,
      sessionId: input.sessionId,
      delivery: input.delivery,
      expectedTurnId: input.expectedTurnId,
      parts,
      execution,
    })
    const existing = loadRuntimeInput(connection, input.inputId)
    if (existing) {
      if (existing.payload_checksum !== fingerprint) {
        throw new SessionRuntimeConflictError(
          "input_conflict",
          `Input id ${input.inputId} was already used for different content`,
        )
      }
      return inputFromRow(existing)
    }
    const reservedTurnId = this.#id("turn")
    const reservedRunId = this.#id("run")
    const admittedSequence = allocateRuntimeInputSequence(
      connection,
      input.sessionId,
    )
    connection.run(
      `INSERT INTO runtime_session_input
        (id, session_id, delivery, admitted_sequence, expected_turn_id,
         reserved_turn_id, reserved_run_id, payload_checksum, parts_json,
         execution_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.inputId,
        input.sessionId,
        input.delivery,
        admittedSequence,
        input.expectedTurnId ?? null,
        reservedTurnId,
        reservedRunId,
        fingerprint,
        canonicalJson(parts),
        canonicalJson(execution),
        createdAt,
      ],
    )
    const admitted: RuntimeAdmittedInput = Object.freeze({
      id: input.inputId,
      reservedTurnId,
      reservedRunId,
      sessionId: input.sessionId,
      delivery: input.delivery,
      parts,
      execution,
      admittedSequence,
      ...(input.expectedTurnId === undefined
        ? {}
        : { expectedTurnId: input.expectedTurnId }),
    })
    appendProtocolEvent(connection, {
      sessionId: input.sessionId,
      turnId: reservedTurnId,
      runId: reservedRunId,
      emittedAt: createdAt,
      createEventId: () => this.#id("event"),
      payload: {
        type: "input_admitted",
        inputId: input.inputId,
        reservedTurnId,
        reservedRunId,
        delivery: input.delivery,
        ...(input.expectedTurnId === undefined
          ? {}
          : { expectedTurnId: input.expectedTurnId }),
        admittedSequence,
        execution,
      },
    })
    return admitted
  }

  #requestInterrupt(
    connection: StateConnection,
    active: RuntimeTurnRow,
    fence: RuntimeOwnershipFence,
    reason: string | undefined,
    requestedAt: number,
  ): void {
    this.#assertTurnFence(active, fence)
    if (active.interrupt_requested_at !== null) return
    connection.run(
      `UPDATE session_turn
       SET interrupt_requested_at = ?, interrupt_reason = ?, updated_at = ?
       WHERE id = ? AND result_status IS NULL
         AND owner_id = ? AND lease_epoch = ?`,
      [
        requestedAt,
        reason ?? null,
        requestedAt,
        active.id,
        fence.ownerId,
        fence.leaseEpoch,
      ],
    )
    appendProtocolEvent(connection, {
      sessionId: active.session_id,
      turnId: active.id,
      runId: active.run_id,
      emittedAt: requestedAt,
      createEventId: () => this.#id("event"),
      payload: {
        type: "interrupt_requested",
        ...(reason === undefined ? {} : { reason }),
      },
    })
  }

  #finishTurn(
    connection: StateConnection,
    input: {
      sessionId: string
      turnId: string
      result: RuntimeTurnResult
      fence: RuntimeOwnershipFence
    },
    recovery: boolean,
  ): { requeuedInputs: readonly RuntimeAdmittedInput[] } {
    const observedAt = readRuntimeTimestamp(this.#now)
    const lease = requireLiveRuntimeFence(
      connection,
      input.sessionId,
      input.fence,
      observedAt,
    )
    const active = loadActiveTurn(connection, input.sessionId)
    if (!active) {
      const finished = connection.get<RuntimeTurnRow>(
        `SELECT id, session_id, run_id, input_id, phase, execution_json,
                config_epoch, context_epoch, owner_id, lease_epoch,
                interrupt_requested_at, interrupt_reason, result_status,
                result_error, created_at, updated_at, finished_at
         FROM session_turn
         WHERE id = ? AND session_id = ?`,
        [input.turnId, input.sessionId],
      )
      if (
        !finished ||
        finished.result_status !== input.result.status ||
        (!recovery &&
          (finished.owner_id !== input.fence.ownerId ||
            finished.lease_epoch !== input.fence.leaseEpoch))
      ) {
        throw new SessionRuntimeConflictError(
          "turn_conflict",
          `Turn ${input.turnId} is not the active turn`,
        )
      }
      return {
        requeuedInputs: this.#requeuedInputs(
          connection,
          input.sessionId,
          input.turnId,
        ),
      }
    }
    if (active.id !== input.turnId) {
      throw new SessionRuntimeConflictError(
        "turn_conflict",
        `Expected active turn ${input.turnId}, found ${active.id}`,
      )
    }
    if (!recovery) this.#assertTurnFence(active, input.fence)
    const finishedAt = monotonicRuntimeTimestamp(
      connection,
      input.sessionId,
      this.#now,
      lease.updated_at,
      active.updated_at,
    )
    const pendingSteers = connection.all<RuntimeInputRow>(
      `SELECT id, session_id, delivery, admitted_sequence,
              promoted_sequence, expected_turn_id, reserved_turn_id,
              reserved_run_id, payload_checksum, parts_json,
              execution_json, created_at, requeued_from_turn_id
       FROM runtime_session_input
       WHERE session_id = ?
         AND delivery = 'steer'
         AND expected_turn_id = ?
         AND promoted_sequence IS NULL
       ORDER BY admitted_sequence`,
      [input.sessionId, input.turnId],
    )
    if (pendingSteers.length > 0) {
      connection.run(
        `UPDATE runtime_session_input
         SET delivery = 'queue',
             expected_turn_id = NULL,
             requeued_from_turn_id = ?
         WHERE session_id = ?
           AND delivery = 'steer'
           AND expected_turn_id = ?
           AND promoted_sequence IS NULL`,
        [input.turnId, input.sessionId, input.turnId],
      )
    }
    const requeuedInputs = pendingSteers.map((row) =>
      inputFromRow({
        ...row,
        delivery: "queue",
        expected_turn_id: null,
        requeued_from_turn_id: input.turnId,
      }),
    )
    const terminalPhase =
      input.result.status === "completed" ? "settling" : input.result.status
    connection.run(
      `UPDATE session_turn
       SET phase = ?, result_status = ?, result_error = ?,
           updated_at = ?, finished_at = ?
       WHERE id = ? AND result_status IS NULL`,
      [
        terminalPhase,
        input.result.status,
        "error" in input.result ? input.result.error ?? null : null,
        finishedAt,
        finishedAt,
        input.turnId,
      ],
    )
    const cancelledApprovals = connection.all<{ id: string }>(
      `SELECT id
       FROM approval
       WHERE run_id = ?
         AND (
           status = 'pending'
           OR (? = 1 AND status = 'cancelled')
         )
       ORDER BY created_at, id`,
      [active.run_id, recovery ? 1 : 0],
    )
    connection.run(
      `UPDATE run
       SET status = ?, finished_at = ?
       WHERE id = ? AND status = 'running'`,
      [statusForRun(input.result), finishedAt, active.run_id],
    )
    connection.run(
      `UPDATE approval
       SET status = 'cancelled', resolved_at = ?
       WHERE run_id = ? AND status = 'pending'`,
      [finishedAt, active.run_id],
    )
    for (const approval of cancelledApprovals) {
      appendProtocolEvent(connection, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: active.run_id,
        emittedAt: finishedAt,
        createEventId: () => this.#id("event"),
        payload: {
          type: "approval_resolved",
          approvalId: approval.id,
          status: "cancelled",
        },
      })
    }
    if (requeuedInputs.length > 0) {
      appendProtocolEvent(connection, {
        sessionId: input.sessionId,
        turnId: input.turnId,
        runId: active.run_id,
        emittedAt: finishedAt,
        createEventId: () => this.#id("event"),
        payload: {
          type: "steering_requeued",
          inputIds: requeuedInputs.map((item) => item.id),
        },
      })
    }
    appendProtocolEvent(connection, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: active.run_id,
      emittedAt: finishedAt,
      createEventId: () => this.#id("event"),
      payload: {
        type: "turn_finished",
        status: input.result.status,
        ...("error" in input.result && input.result.error
          ? { error: input.result.error }
          : {}),
      },
    })
    return { requeuedInputs }
  }

  #resolveApproval(
    connection: StateConnection,
    input: {
      sessionId: string
      approvalId: string
      expectedTurnId: string
      status: "approved" | "denied"
      fence: RuntimeOwnershipFence
    },
    active: RuntimeTurnRow,
    resolvedAt: number,
  ): void {
    assertRuntimeIdentifier(input.approvalId, "Approval id")
    this.#assertTurnFence(active, input.fence)
    const approval = this.#loadApproval(connection, input.approvalId)
    if (
      !approval ||
      approval.session_id !== input.sessionId ||
      approval.run_id !== active.run_id
    ) {
      throw new SessionRuntimeConflictError(
        "approval_conflict",
        `Approval ${input.approvalId} does not belong to the active turn`,
      )
    }
    if (approval.status !== "pending") {
      if (approval.status === input.status) return
      throw new SessionRuntimeConflictError(
        "approval_conflict",
        `Approval ${input.approvalId} was already resolved as ${approval.status}`,
      )
    }
    connection.run(
      `UPDATE approval
       SET status = ?, resolved_at = ?
       WHERE id = ? AND status = 'pending'`,
      [input.status, resolvedAt, input.approvalId],
    )
    appendProtocolEvent(connection, {
      sessionId: input.sessionId,
      turnId: active.id,
      runId: active.run_id,
      emittedAt: resolvedAt,
      createEventId: () => this.#id("event"),
      payload: {
        type: "approval_resolved",
        approvalId: input.approvalId,
        status: input.status,
      },
    })
  }

  #snapshot(
    connection: StateReadConnection,
    sessionId: string,
  ): RuntimeSessionSnapshot {
    const active = loadActiveTurn(connection, sessionId)
    const activeInput = active
      ? loadRuntimeInput(connection, active.input_id)
      : undefined
    if (active && !activeInput) {
      throw new Error(`Active turn ${active.id} has no input reservation`)
    }
    const pendingRows = connection.all<RuntimeInputRow>(
      `SELECT id, session_id, delivery, admitted_sequence,
              promoted_sequence, expected_turn_id, reserved_turn_id,
              reserved_run_id, payload_checksum, parts_json,
              execution_json, created_at, requeued_from_turn_id
       FROM runtime_session_input
       WHERE session_id = ? AND promoted_sequence IS NULL
       ORDER BY admitted_sequence`,
      [sessionId],
    )
    const pendingApprovalRows =
      connection.all<PendingApprovalSnapshotRow>(
        `SELECT approval.id AS approval_id,
                session_turn.id AS turn_id,
                approval.tool_name AS tool_name,
                approval.redacted_summary AS redacted_summary
         FROM approval
         JOIN session_turn
           ON session_turn.run_id = approval.run_id
          AND session_turn.session_id = approval.session_id
         WHERE approval.session_id = ?
           AND approval.status = 'pending'
           AND session_turn.result_status IS NULL
         ORDER BY approval.created_at, approval.id`,
        [sessionId],
      )
    let phase: RuntimeSessionPhase = "idle"
    if (active) {
      phase = active.phase
    } else {
      const last = connection.get<{ result_status: string }>(
        `SELECT result_status
         FROM session_turn
         WHERE session_id = ? AND result_status IS NOT NULL
         ORDER BY finished_at DESC, id DESC
         LIMIT 1`,
        [sessionId],
      )
      if (last?.result_status === "failed") phase = "failed"
      if (last?.result_status === "interrupted") phase = "interrupted"
    }
    return {
      sessionId,
      phase,
      ...(active && activeInput
        ? { activeTurn: turnFromRows(active, activeInput) }
        : {}),
      pendingApprovals: pendingApprovalRows.map((row) => {
        assertRuntimeIdentifier(row.approval_id, "Stored approval id")
        assertRuntimeIdentifier(row.turn_id, "Stored approval turn id")
        if (
          !row.tool_name.trim() ||
          row.tool_name.length > 256 ||
          !row.redacted_summary.trim() ||
          row.redacted_summary.length > 20_000
        ) {
          throw new Error("Stored pending approval metadata is invalid")
        }
        if (!active || row.turn_id !== active.id) {
          throw new Error(
            `Pending approval ${row.approval_id} does not belong to the active turn`,
          )
        }
        return Object.freeze({
          approvalId: row.approval_id,
          turnId: row.turn_id,
          toolName: row.tool_name,
          redactedSummary: row.redacted_summary,
        })
      }),
      pendingQueue: pendingRows
        .filter((row) => row.delivery === "queue")
        .map(inputFromRow),
      pendingSteers: pendingRows
        .filter((row) => row.delivery === "steer")
        .map(inputFromRow),
    }
  }

  #replayWindow(
    connection: StateReadConnection,
    sessionId: string,
  ): RuntimeReplayWindow {
    const row = connection.get<{
      earliest: number | null
      latest: number | null
    }>(
      `SELECT MIN(sequence) AS earliest, MAX(sequence) AS latest
       FROM protocol_event
       WHERE session_id = ?`,
      [sessionId],
    )
    return {
      earliestAvailableSequence: row?.earliest ?? 1,
      throughSequence: row?.latest ?? 0,
    }
  }

  #requeuedInputs(
    connection: StateReadConnection,
    sessionId: string,
    turnId: string,
  ): readonly RuntimeAdmittedInput[] {
    return connection
      .all<RuntimeInputRow>(
        `SELECT id, session_id, delivery, admitted_sequence,
                promoted_sequence, expected_turn_id, reserved_turn_id,
                reserved_run_id, payload_checksum, parts_json,
                execution_json, created_at, requeued_from_turn_id
         FROM runtime_session_input
         WHERE session_id = ? AND requeued_from_turn_id = ?
         ORDER BY admitted_sequence`,
        [sessionId, turnId],
      )
      .map(inputFromRow)
  }

  #requireActive(
    connection: StateReadConnection,
    sessionId: string,
    expectedTurnId: string,
  ): RuntimeTurnRow {
    assertRuntimeIdentifier(expectedTurnId, "Expected turn id")
    const active = loadActiveTurn(connection, sessionId)
    if (!active) {
      throw new SessionRuntimeConflictError(
        "no_active_turn",
        `Session ${sessionId} has no active turn`,
      )
    }
    if (active.id !== expectedTurnId) {
      throw new SessionRuntimeConflictError(
        "turn_conflict",
        `Expected active turn ${expectedTurnId}, found ${active.id}`,
      )
    }
    return active
  }

  #assertTurnFence(
    turn: RuntimeTurnRow,
    fence: RuntimeOwnershipFence,
  ): void {
    if (
      turn.owner_id !== fence.ownerId ||
      turn.lease_epoch !== fence.leaseEpoch
    ) {
      throw new SessionRuntimeConflictError(
        "lease_lost",
        `Turn ${turn.id} is fenced by another session owner`,
      )
    }
  }

  #loadApproval(
    connection: StateReadConnection,
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

  #id(kind: "turn" | "run" | "event"): string {
    const value = this.#createId(kind)
    assertRuntimeIdentifier(value, `${kind} id`)
    return value
  }
}
