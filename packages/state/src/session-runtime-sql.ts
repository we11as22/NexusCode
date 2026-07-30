import { createHash } from "node:crypto"

import type { StateConnection, StateReadConnection } from "./schema.js"
import {
  SessionRuntimeConflictError,
  type RuntimeAdmittedInput,
  type RuntimeDurableTurn,
  type RuntimeEpochSnapshot,
  type RuntimeExecutionSnapshot,
  type RuntimeInputPart,
  type RuntimeOwnershipFence,
  type RuntimeProtocolEnvelope,
} from "./session-runtime-types.js"

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const MODES = new Set(["agent", "plan", "ask", "debug", "review"])
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])
const MAX_TEXT_CHARACTERS = 1 << 20
const MAX_IMAGE_BASE64_CHARACTERS = 5 * 1_024 * 1_024
const MAX_PARTS = 64
const MAX_IMAGES = 8

export type RuntimeInputRow = {
  id: string
  session_id: string
  delivery: "steer" | "queue"
  admitted_sequence: number
  promoted_sequence: number | null
  expected_turn_id: string | null
  reserved_turn_id: string
  reserved_run_id: string
  payload_checksum: string
  parts_json: string
  execution_json: string
  created_at: number
  requeued_from_turn_id: string | null
}

export type RuntimeTurnRow = {
  id: string
  session_id: string
  run_id: string
  input_id: string
  phase: Exclude<RuntimeDurableTurn["phase"], "idle">
  execution_json: string
  config_epoch: number
  context_epoch: number
  owner_id: string
  lease_epoch: number
  interrupt_requested_at: number | null
  interrupt_reason: string | null
  result_status: "completed" | "failed" | "interrupted" | null
  result_error: string | null
  created_at: number
  updated_at: number
  finished_at: number | null
}

type LeaseRow = {
  owner_id: string
  epoch: number
  expires_at: number
  updated_at: number
}

type ProtocolEventRow = {
  event_id: string
  session_id: string
  sequence: number
  turn_id: string | null
  run_id: string | null
  parent_event_id: string | null
  payload_json: string
  emitted_at: number
  rollout_status: "pending" | "projected" | "not_applicable"
}

export function assertRuntimeIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(
      `${label} must be a protocol-safe identifier of at most 128 characters`,
    )
  }
}

export function readRuntimeTimestamp(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(
      "Session runtime clock must return a non-negative safe integer",
    )
  }
  return value
}

export function normalizeExecution(
  execution: RuntimeExecutionSnapshot,
): RuntimeExecutionSnapshot {
  if (!execution || !MODES.has(execution.mode)) {
    throw new Error("Session runtime execution requires a supported mode")
  }
  if (!execution.selection) return Object.freeze({ mode: execution.mode })
  assertRuntimeIdentifier(execution.selection.profileId, "Model profile id")
  if (
    !Number.isSafeInteger(execution.selection.selectionEpoch) ||
    execution.selection.selectionEpoch < 0
  ) {
    throw new Error(
      "Model selection epoch must be a non-negative safe integer",
    )
  }
  return Object.freeze({
    mode: execution.mode,
    selection: Object.freeze({
      profileId: execution.selection.profileId,
      selectionEpoch: execution.selection.selectionEpoch,
    }),
  })
}

function canonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
    value,
  )
}

export function normalizeRuntimeParts(
  parts: readonly RuntimeInputPart[],
): readonly RuntimeInputPart[] {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_PARTS) {
    throw new Error(`Session input must contain from 1 to ${MAX_PARTS} parts`)
  }
  let textCharacters = 0
  let images = 0
  const normalized = parts.map((part): RuntimeInputPart => {
    if (!part || typeof part !== "object") {
      throw new Error("Session input parts must be objects")
    }
    if (part.type === "text") {
      if (typeof part.text !== "string" || part.text.length === 0) {
        throw new Error("Text input parts must not be empty")
      }
      if (
        part.user_message !== undefined &&
        (typeof part.user_message !== "string" ||
          part.user_message.trim().length === 0 ||
          part.user_message.length > 16_384)
      ) {
        throw new Error(
          "Text input display projections must contain from 1 to 16384 characters",
        )
      }
      textCharacters += part.text.length
      return Object.freeze({
        type: "text",
        text: part.text,
        ...(part.user_message
          ? { user_message: part.user_message.trim() }
          : {}),
      })
    }
    if (part.type === "image") {
      if (
        typeof part.data !== "string" ||
        part.data.length === 0 ||
        part.data.length > MAX_IMAGE_BASE64_CHARACTERS ||
        !canonicalBase64(part.data) ||
        !IMAGE_MIME_TYPES.has(part.mimeType)
      ) {
        throw new Error(
          "Image input requires bounded canonical base64 and a supported MIME type",
        )
      }
      images += 1
      return Object.freeze({
        type: "image",
        mimeType: part.mimeType,
        data: part.data,
      })
    }
    if (part.type === "mention") {
      if (
        typeof part.name !== "string" ||
        part.name.trim().length === 0 ||
        part.name.length > 256 ||
        typeof part.path !== "string" ||
        part.path.length === 0 ||
        part.path.length > 4096 ||
        part.path.includes("\0")
      ) {
        throw new Error("Mention input requires a bounded name and safe path")
      }
      return Object.freeze({
        type: "mention",
        name: part.name,
        path: part.path,
      })
    }
    if (
      part.type !== "skill" ||
      typeof part.name !== "string" ||
      part.name.trim().length === 0 ||
      part.name.length > 256
    ) {
      throw new Error("Skill input requires a bounded name")
    }
    return Object.freeze({ type: "skill", name: part.name })
  })
  if (textCharacters > MAX_TEXT_CHARACTERS) {
    throw new Error(
      `Session input exceeds ${MAX_TEXT_CHARACTERS} text characters`,
    )
  }
  if (images > MAX_IMAGES) {
    throw new Error(`Session input contains more than ${MAX_IMAGES} images`)
  }
  return Object.freeze(normalized)
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T
  } catch {
    throw new Error(`Stored ${label} is not valid JSON`)
  }
}

export function inputFromRow(row: RuntimeInputRow): RuntimeAdmittedInput {
  const parts = normalizeRuntimeParts(
    parseJson<readonly RuntimeInputPart[]>(row.parts_json, "session input"),
  )
  const execution = normalizeExecution(
    parseJson<RuntimeExecutionSnapshot>(
      row.execution_json,
      "execution snapshot",
    ),
  )
  return Object.freeze({
    id: row.id,
    reservedTurnId: row.reserved_turn_id,
    reservedRunId: row.reserved_run_id,
    sessionId: row.session_id,
    delivery: row.delivery,
    parts,
    execution,
    admittedSequence: row.admitted_sequence,
    ...(row.promoted_sequence === null
      ? {}
      : { promotedSequence: row.promoted_sequence }),
    ...(row.expected_turn_id === null
      ? {}
      : { expectedTurnId: row.expected_turn_id }),
  })
}

export function loadRuntimeInput(
  connection: StateReadConnection,
  inputId: string,
): RuntimeInputRow | undefined {
  return connection.get<RuntimeInputRow>(
    `SELECT id, session_id, delivery, admitted_sequence, promoted_sequence,
            expected_turn_id, reserved_turn_id, reserved_run_id,
            payload_checksum, parts_json, execution_json, created_at,
            requeued_from_turn_id
     FROM runtime_session_input
     WHERE id = ?`,
    [inputId],
  )
}

export function loadActiveTurn(
  connection: StateReadConnection,
  sessionId: string,
): RuntimeTurnRow | undefined {
  return connection.get<RuntimeTurnRow>(
    `SELECT id, session_id, run_id, input_id, phase, execution_json,
            config_epoch, context_epoch, owner_id, lease_epoch,
            interrupt_requested_at, interrupt_reason, result_status,
            result_error, created_at, updated_at, finished_at
     FROM session_turn
     WHERE session_id = ? AND result_status IS NULL`,
    [sessionId],
  )
}

export function requireLiveRuntimeFence(
  connection: StateReadConnection,
  sessionId: string,
  fence: RuntimeOwnershipFence,
  observedAt: number,
): LeaseRow {
  assertRuntimeIdentifier(sessionId, "Session id")
  assertRuntimeIdentifier(fence.ownerId, "Session owner id")
  if (!Number.isSafeInteger(fence.leaseEpoch) || fence.leaseEpoch < 1) {
    throw new Error("Session lease epoch must be a positive safe integer")
  }
  const lease = connection.get<LeaseRow>(
    `SELECT owner_id, epoch, expires_at, updated_at
     FROM session_lease
     WHERE session_id = ?`,
    [sessionId],
  )
  if (
    !lease ||
    lease.owner_id !== fence.ownerId ||
    lease.epoch !== fence.leaseEpoch ||
    lease.expires_at <= observedAt
  ) {
    throw new SessionRuntimeConflictError(
      "lease_lost",
      `Session lease ${sessionId}@${fence.leaseEpoch} is no longer owned by ${fence.ownerId}`,
    )
  }
  return lease
}

export function monotonicRuntimeTimestamp(
  connection: StateReadConnection,
  sessionId: string,
  now: () => number,
  ...floors: number[]
): number {
  const row = connection.get<{ emitted_at: number | null }>(
    `SELECT MAX(emitted_at) AS emitted_at
     FROM protocol_event
     WHERE session_id = ?`,
    [sessionId],
  )
  return Math.max(readRuntimeTimestamp(now), row?.emitted_at ?? 0, ...floors)
}

export function allocateRuntimeInputSequence(
  connection: StateConnection,
  sessionId: string,
): number {
  const row = connection.get<{ sequence: number }>(
    `INSERT INTO runtime_session_sequence (session_id, last_input_sequence)
     VALUES (?, 1)
     ON CONFLICT(session_id) DO UPDATE
       SET last_input_sequence = last_input_sequence + 1
     RETURNING last_input_sequence AS sequence`,
    [sessionId],
  )
  if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    throw new Error("Failed to allocate a session input sequence")
  }
  return row.sequence
}

function allocateProtocolSequence(
  connection: StateConnection,
  sessionId: string,
): number {
  const row = connection.get<{ sequence: number }>(
    `INSERT INTO protocol_event_sequence (session_id, last_sequence)
     VALUES (?, 1)
     ON CONFLICT(session_id) DO UPDATE
       SET last_sequence = last_sequence + 1
     RETURNING last_sequence AS sequence`,
    [sessionId],
  )
  if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    throw new Error("Failed to allocate a protocol event sequence")
  }
  return row.sequence
}

export function appendProtocolEvent(
  connection: StateConnection,
  input: {
    sessionId: string
    turnId?: string
    runId?: string
    parentEventId?: string
    payload: RuntimeProtocolEnvelope["payload"]
    emittedAt: number
    createEventId: () => string
    rollout?: "pending" | "projected" | "not_applicable"
  },
): RuntimeProtocolEnvelope {
  if ((input.turnId === undefined) !== (input.runId === undefined)) {
    throw new Error("Protocol events require paired turn and run identities")
  }
  const eventId = input.createEventId()
  assertRuntimeIdentifier(eventId, "Protocol event id")
  const sequence = allocateProtocolSequence(connection, input.sessionId)
  connection.run(
    `INSERT INTO protocol_event
      (event_id, session_id, sequence, turn_id, run_id, parent_event_id,
       payload_json, emitted_at, rollout_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      eventId,
      input.sessionId,
      sequence,
      input.turnId ?? null,
      input.runId ?? null,
      input.parentEventId ?? null,
      JSON.stringify(input.payload),
      input.emittedAt,
      input.rollout ?? "pending",
    ],
  )
  return {
    version: 2,
    eventId,
    sequence,
    sessionId: input.sessionId,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.parentEventId === undefined
      ? {}
      : { parentEventId: input.parentEventId }),
    emittedAt: input.emittedAt,
    persistence: {
      state: "committed",
      rollout: input.rollout ?? "pending",
    },
    payload: input.payload,
  }
}

export function protocolEnvelopeFromRow(
  row: ProtocolEventRow,
): RuntimeProtocolEnvelope {
  const payload = parseJson<RuntimeProtocolEnvelope["payload"]>(
    row.payload_json,
    "protocol event payload",
  )
  if (!payload || typeof payload !== "object" || typeof payload.type !== "string") {
    throw new Error(`Stored protocol event ${row.event_id} has invalid payload`)
  }
  return {
    version: 2,
    eventId: row.event_id,
    sequence: row.sequence,
    sessionId: row.session_id,
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.parent_event_id === null
      ? {}
      : { parentEventId: row.parent_event_id }),
    emittedAt: row.emitted_at,
    persistence: {
      state: "committed",
      rollout: row.rollout_status,
    },
    payload,
  }
}

export function loadProtocolEvents(
  connection: StateReadConnection,
  sessionId: string,
  afterSequence: number,
  limit: number,
): RuntimeProtocolEnvelope[] {
  return connection
    .all<ProtocolEventRow>(
      `SELECT event_id, session_id, sequence, turn_id, run_id,
              parent_event_id, payload_json, emitted_at, rollout_status
       FROM protocol_event
       WHERE session_id = ? AND sequence > ?
       ORDER BY sequence
       LIMIT ?`,
      [sessionId, afterSequence, limit],
    )
    .map(protocolEnvelopeFromRow)
}

export function canonicalJson(value: unknown): string {
  const visit = (candidate: unknown): unknown => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new Error("Command fingerprints require finite JSON numbers")
      }
      return candidate
    }
    if (Array.isArray(candidate)) return candidate.map(visit)
    if (
      typeof candidate !== "object" ||
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      throw new Error("Command fingerprints require plain JSON values")
    }
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, visit(item)]),
    )
  }
  return JSON.stringify(visit(value))
}

export function checksumJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function assertEpochs(epochs: RuntimeEpochSnapshot): void {
  if (
    !Number.isSafeInteger(epochs.configEpoch) ||
    epochs.configEpoch < 0 ||
    !Number.isSafeInteger(epochs.contextEpoch) ||
    epochs.contextEpoch < 0
  ) {
    throw new Error("Turn epochs must be non-negative safe integers")
  }
}

export function turnFromRows(
  turn: RuntimeTurnRow,
  input: RuntimeInputRow,
  modeOverride?: RuntimeDurableTurn["modeOverride"],
): RuntimeDurableTurn {
  const execution = normalizeExecution(
    parseJson<RuntimeExecutionSnapshot>(
      turn.execution_json,
      "turn execution snapshot",
    ),
  )
  return Object.freeze({
    turnId: turn.id,
    runId: turn.run_id,
    input: inputFromRow(input),
    phase: turn.phase,
    epochs: Object.freeze({
      configEpoch: turn.config_epoch,
      contextEpoch: turn.context_epoch,
    }),
    execution,
    ...(modeOverride === undefined
      ? {}
      : {
          modeOverride: Object.freeze({
            requestedByTurnId: modeOverride.requestedByTurnId,
          }),
        }),
    fence: Object.freeze({
      ownerId: turn.owner_id,
      leaseEpoch: turn.lease_epoch,
    }),
  })
}
