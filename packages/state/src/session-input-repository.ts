import { createHash } from "node:crypto"
import type { NexusStateDatabase } from "./database.js"
import type { StateConnection } from "./schema.js"

export type InputDelivery = "steer" | "queue"

export type UserInputPartRecord =
  | { type: "text"; text: string; user_message?: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "mention"; name: string; path: string }
  | { type: "skill"; name: string }

export interface AdmitInput {
  id: string
  sessionId: string
  delivery: InputDelivery
  parts: readonly UserInputPartRecord[]
}

export interface AdmittedInput {
  id: string
  sessionId: string
  admittedSequence: number
  promotedSequence?: number
  delivery: InputDelivery
  parts: readonly UserInputPartRecord[]
  createdAt: number
}

export interface SessionInputRepositoryOptions {
  now?: () => number
}

export class InputConflictError extends Error {
  readonly inputId: string

  constructor(inputId: string) {
    super(`Input ${inputId} was already admitted with a different payload`)
    this.name = "InputConflictError"
    this.inputId = inputId
  }
}

type SessionInputRow = {
  id: string
  session_id: string
  delivery: string
  admitted_sequence: number
  promoted_sequence: number | null
  payload_checksum: string
  parts_json: string
  created_at: number
}

type SequenceRow = { sequence: number }

const INPUT_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const MAX_USER_INPUT_TEXT_CHARS = 1 << 20
const MAX_IMAGE_BASE64_CHARS = 5 * 1_024 * 1_024
const MAX_INPUT_PARTS = 64
const MAX_IMAGES_PER_INPUT = 8
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
])

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !INPUT_IDENTIFIER.test(value)) {
    throw new Error(
      `${label} must be a protocol-safe identifier of at most 128 characters`,
    )
  }
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
    value,
  )
}

function normalizeParts(
  parts: readonly UserInputPartRecord[],
): UserInputPartRecord[] {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Input must contain at least one part")
  }
  if (parts.length > MAX_INPUT_PARTS) {
    throw new Error(`Input must contain at most ${MAX_INPUT_PARTS} parts`)
  }

  let textCharacters = 0
  let imageCount = 0
  const normalized = parts.map((part): UserInputPartRecord => {
    if (typeof part !== "object" || part === null) {
      throw new Error("Input parts must be objects")
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
      return {
        type: "text",
        text: part.text,
        ...(part.user_message
          ? { user_message: part.user_message.trim() }
          : {}),
      }
    }
    if (part.type === "mention") {
      if (
        typeof part.name !== "string" ||
        part.name.trim().length === 0 ||
        part.name.length > 256 ||
        typeof part.path !== "string" ||
        part.path.length === 0 ||
        part.path.length > 4_096 ||
        part.path.includes("\0")
      ) {
        throw new Error(
          "Mention input parts require a bounded name and NUL-free path",
        )
      }
      return { type: "mention", name: part.name, path: part.path }
    }
    if (part.type === "skill") {
      if (
        typeof part.name !== "string" ||
        part.name.trim().length === 0 ||
        part.name.length > 256
      ) {
        throw new Error("Skill input parts require a bounded name")
      }
      return { type: "skill", name: part.name }
    }
    if (
      part.type !== "image" ||
      typeof part.data !== "string" ||
      part.data.length === 0 ||
      part.data.length > MAX_IMAGE_BASE64_CHARS ||
      !isCanonicalBase64(part.data) ||
      typeof part.mimeType !== "string" ||
      !IMAGE_MIME_TYPES.has(part.mimeType)
    ) {
      if (
        part.type === "image" &&
        typeof part.data === "string" &&
        part.data.length > 0 &&
        part.data.length <= MAX_IMAGE_BASE64_CHARS &&
        !isCanonicalBase64(part.data)
      ) {
        throw new Error("Image input data must be canonical base64")
      }
      throw new Error(
        "Image input parts require bounded base64 data and a supported image MIME type",
      )
    }
    imageCount += 1
    return { type: "image", data: part.data, mimeType: part.mimeType }
  })

  if (textCharacters > MAX_USER_INPUT_TEXT_CHARS) {
    throw new Error(
      `Input text exceeds the ${MAX_USER_INPUT_TEXT_CHARS} character limit`,
    )
  }
  if (imageCount > MAX_IMAGES_PER_INPUT) {
    throw new Error(`Input must contain at most ${MAX_IMAGES_PER_INPUT} images`)
  }
  return normalized
}

function readInputTime(now: () => number): number {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Input clock must return a non-negative safe integer")
  }
  return value
}

function monotonicInputTime(
  connection: StateConnection,
  sessionId: string,
  now: () => number,
  floor = 0,
): number {
  const row = connection.get<{ created_at: number | null }>(
    `SELECT MAX(created_at) AS created_at
     FROM durable_event
     WHERE aggregate_id = ?`,
    [`session:${sessionId}`],
  )
  return Math.max(readInputTime(now), floor, row?.created_at ?? 0)
}

function parseParts(json: string): readonly UserInputPartRecord[] {
  const value: unknown = JSON.parse(json)
  return normalizeParts(value as readonly UserInputPartRecord[])
}

function fingerprint(
  input: Omit<AdmitInput, "parts"> & {
    parts: readonly UserInputPartRecord[]
  },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: input.id,
        sessionId: input.sessionId,
        delivery: input.delivery,
        parts: input.parts,
      }),
    )
    .digest("hex")
}

function admittedInputFromRow(row: SessionInputRow): AdmittedInput {
  if (row.delivery !== "steer" && row.delivery !== "queue") {
    throw new Error(`Invalid stored input delivery: ${row.delivery}`)
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    admittedSequence: row.admitted_sequence,
    ...(row.promoted_sequence === null
      ? {}
      : { promotedSequence: row.promoted_sequence }),
    delivery: row.delivery,
    parts: parseParts(row.parts_json),
    createdAt: row.created_at,
  }
}

function loadInput(
  connection: StateConnection,
  inputId: string,
): SessionInputRow | undefined {
  return connection.get<SessionInputRow>(
    `SELECT id, session_id, delivery, admitted_sequence, promoted_sequence,
            payload_checksum, parts_json, created_at
     FROM session_input
     WHERE id = ?`,
    [inputId],
  )
}

function allocateSequence(
  connection: StateConnection,
  sessionId: string,
): number {
  const aggregateId = `session:${sessionId}`
  const row = connection.get<SequenceRow>(
    `INSERT INTO aggregate_sequence (aggregate_id, last_sequence)
     VALUES (?, 1)
     ON CONFLICT(aggregate_id) DO UPDATE
       SET last_sequence = last_sequence + 1
     RETURNING last_sequence AS sequence`,
    [aggregateId],
  )
  if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 1) {
    throw new Error(`Failed to allocate an event sequence for ${aggregateId}`)
  }
  return row.sequence
}

export class SessionInputRepository {
  readonly #database: NexusStateDatabase
  readonly #now: () => number

  constructor(
    database: NexusStateDatabase,
    options: SessionInputRepositoryOptions = {},
  ) {
    this.#database = database
    this.#now = options.now ?? Date.now
  }

  admit(input: AdmitInput): AdmittedInput {
    assertIdentifier(input.id, "Input id")
    assertIdentifier(input.sessionId, "Session id")
    if (input.delivery !== "steer" && input.delivery !== "queue") {
      throw new Error(`Unsupported input delivery: ${String(input.delivery)}`)
    }
    const parts = normalizeParts(input.parts)
    const checksum = fingerprint({ ...input, parts })

    return this.#database.transaction((connection) => {
      const existing = loadInput(connection, input.id)
      if (existing) {
        if (existing.payload_checksum !== checksum) {
          throw new InputConflictError(input.id)
        }
        return admittedInputFromRow(existing)
      }

      const createdAt = monotonicInputTime(
        connection,
        input.sessionId,
        this.#now,
      )
      const admittedSequence = allocateSequence(connection, input.sessionId)
      const partsJson = JSON.stringify(parts)
      connection.run(
        `INSERT INTO session_input
          (id, session_id, delivery, admitted_sequence, payload_checksum,
           parts_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.id,
          input.sessionId,
          input.delivery,
          admittedSequence,
          checksum,
          partsJson,
          createdAt,
        ],
      )
      connection.run(
        `INSERT INTO durable_event
          (id, aggregate_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          `input:${input.id}:admitted`,
          `session:${input.sessionId}`,
          admittedSequence,
          "input.admitted",
          JSON.stringify({
            inputId: input.id,
            delivery: input.delivery,
            parts,
          }),
          createdAt,
        ],
      )

      return {
        id: input.id,
        sessionId: input.sessionId,
        admittedSequence,
        delivery: input.delivery,
        parts,
        createdAt,
      }
    })
  }

  pending(
    sessionId: string,
    delivery?: InputDelivery,
  ): AdmittedInput[] {
    assertIdentifier(sessionId, "Session id")
    const rows = delivery
      ? this.#database.read((connection) =>
          connection.all<SessionInputRow>(
            `SELECT id, session_id, delivery, admitted_sequence,
                    promoted_sequence, payload_checksum, parts_json, created_at
             FROM session_input
             WHERE session_id = ? AND delivery = ? AND promoted_sequence IS NULL
             ORDER BY admitted_sequence`,
            [sessionId, delivery],
          ),
        )
      : this.#database.read((connection) =>
          connection.all<SessionInputRow>(
            `SELECT id, session_id, delivery, admitted_sequence,
                    promoted_sequence, payload_checksum, parts_json, created_at
             FROM session_input
             WHERE session_id = ? AND promoted_sequence IS NULL
             ORDER BY admitted_sequence`,
            [sessionId],
          ),
        )
    return rows.map(admittedInputFromRow)
  }

  promoteSteers(sessionId: string, cutoff: number): AdmittedInput[] {
    assertIdentifier(sessionId, "Session id")
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) {
      throw new Error("Steering cutoff must be a non-negative safe integer")
    }
    return this.#database.transaction((connection) => {
      const rows = connection.all<SessionInputRow>(
        `SELECT id, session_id, delivery, admitted_sequence,
                promoted_sequence, payload_checksum, parts_json, created_at
         FROM session_input
         WHERE session_id = ?
           AND delivery = 'steer'
           AND promoted_sequence IS NULL
           AND admitted_sequence <= ?
         ORDER BY admitted_sequence`,
        [sessionId, cutoff],
      )
      return rows.map((row) => this.#promote(connection, row))
    })
  }

  promoteNextQueued(sessionId: string): AdmittedInput | undefined {
    assertIdentifier(sessionId, "Session id")
    return this.#database.transaction((connection) => {
      const row = connection.get<SessionInputRow>(
        `SELECT id, session_id, delivery, admitted_sequence,
                promoted_sequence, payload_checksum, parts_json, created_at
         FROM session_input
         WHERE session_id = ?
           AND delivery = 'queue'
           AND promoted_sequence IS NULL
         ORDER BY admitted_sequence
         LIMIT 1`,
        [sessionId],
      )
      return row ? this.#promote(connection, row) : undefined
    })
  }

  #promote(
    connection: StateConnection,
    row: SessionInputRow,
  ): AdmittedInput {
    const promotedAt = monotonicInputTime(
      connection,
      row.session_id,
      this.#now,
      row.created_at,
    )
    const promotedSequence = allocateSequence(connection, row.session_id)
    const result = connection.run(
      `UPDATE session_input
       SET promoted_sequence = ?
       WHERE id = ? AND promoted_sequence IS NULL`,
      [promotedSequence, row.id],
    )
    if (Number(result.changes) !== 1) {
      throw new Error(`Input ${row.id} was promoted concurrently`)
    }
    connection.run(
      `INSERT INTO durable_event
        (id, aggregate_id, sequence, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        `input:${row.id}:promoted`,
        `session:${row.session_id}`,
        promotedSequence,
        "input.promoted",
        JSON.stringify({
          inputId: row.id,
          delivery: row.delivery,
          admittedSequence: row.admitted_sequence,
        }),
        promotedAt,
      ],
    )
    return admittedInputFromRow({
      ...row,
      promoted_sequence: promotedSequence,
    })
  }
}
