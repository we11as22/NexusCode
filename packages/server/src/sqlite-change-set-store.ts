import {
  assertChangeSetTransition,
  ChangeSetStoreConflictError,
  hashChangeProposal,
  hashFileContent,
  sameChangeIdentity,
  type ChangeSetListQuery,
  type ChangeSetRecord,
  type ChangeSetState,
  type ChangeSetStore,
} from "@nexuscode/core"
import type {
  NexusStateDatabase,
  StateInputValue,
  StateOutputValue,
} from "@nexuscode/state"

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const CHANGE_SET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const CHANGE_SET_STATES = new Set<ChangeSetState>([
  "proposed",
  "approved",
  "applying",
  "applied",
  "rejected",
  "accepted",
  "reverting",
  "reverted",
  "conflicted",
])
const APPROVED_STATES = new Set<ChangeSetState>([
  "approved",
  "applying",
  "applied",
  "accepted",
  "reverting",
  "reverted",
  "conflicted",
])
const DEFAULT_MAX_BLOB_BYTES = 128 * 1_024 * 1_024
const DEFAULT_MAX_RECORD_BYTES = 64 * 1_024 * 1_024
const DEFAULT_LIST_LIMIT = 10_000

interface ChangeSetRow {
  [key: string]: StateOutputValue
  record_json: string
}

interface BlobRow {
  [key: string]: StateOutputValue
  content: Uint8Array
  byte_length: number
}

export interface SqliteChangeSetStoreOptions {
  maxBlobBytes?: number
  maxRecordBytes?: number
  listLimit?: number
  now?: () => number
}

function positiveSafeInteger(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return value
}

function validateRecord(
  record: ChangeSetRecord,
  workspaceId: string,
): void {
  if (
    record.schemaVersion !== 1 ||
    !CHANGE_SET_ID_PATTERN.test(record.id)
  ) {
    throw new Error("Change-set record id or schema version is invalid")
  }
  if (record.identity.workspaceId !== workspaceId) {
    throw new Error(
      `Change set ${record.id} belongs to another workspace`,
    )
  }
  if (!CHANGE_SET_STATES.has(record.state)) {
    throw new Error(`Change set ${record.id} state is invalid`)
  }
  if (
    hashChangeProposal(record.identity, record.files) !==
    record.proposalHash
  ) {
    throw new Error(
      `Change set ${record.id} proposal hash does not match its files`,
    )
  }
  if (
    record.approvedHash !== undefined &&
    record.approvedHash !== record.proposalHash
  ) {
    throw new Error(`Change set ${record.id} approval hash is stale`)
  }
  if (
    APPROVED_STATES.has(record.state) &&
    record.approvedHash !== record.proposalHash
  ) {
    throw new Error(
      `Change set ${record.id} state ${record.state} requires approval`,
    )
  }
  if (
    (record.state === "proposed" || record.state === "rejected") &&
    record.approvedHash !== undefined
  ) {
    throw new Error(
      `Change set ${record.id} state ${record.state} cannot retain approval`,
    )
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 0) {
    throw new Error(`Change set ${record.id} revision is invalid`)
  }
  if (
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.createdAt < 0 ||
    record.updatedAt < record.createdAt
  ) {
    throw new Error(`Change set ${record.id} timestamps are invalid`)
  }
}

function immutableProjection(record: ChangeSetRecord): unknown {
  return {
    schemaVersion: record.schemaVersion,
    id: record.id,
    identity: record.identity,
    proposalHash: record.proposalHash,
    supersedes: record.supersedes ?? null,
    files: record.files,
    createdAt: record.createdAt,
  }
}

function parseRecord(
  serialized: string,
  workspaceId: string,
): ChangeSetRecord {
  let candidate: unknown
  try {
    candidate = JSON.parse(serialized)
  } catch (error) {
    throw new Error("SQLite change-set record contains invalid JSON", {
      cause: error,
    })
  }
  if (!candidate || typeof candidate !== "object") {
    throw new Error("SQLite change-set record is not an object")
  }
  const record = candidate as ChangeSetRecord
  validateRecord(record, workspaceId)
  return structuredClone(record)
}

function serializeRecord(
  record: ChangeSetRecord,
  maxBytes: number,
): string {
  const serialized = JSON.stringify(record)
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw new RangeError(
      `Change-set record exceeds the ${maxBytes}-byte limit`,
    )
  }
  return serialized
}

function changedExactlyOnce(value: number | bigint): boolean {
  return typeof value === "bigint" ? value === 1n : value === 1
}

export class SqliteChangeSetStore implements ChangeSetStore {
  readonly #database: NexusStateDatabase
  readonly #workspaceId: string
  readonly #maxBlobBytes: number
  readonly #maxRecordBytes: number
  readonly #listLimit: number
  readonly #now: () => number

  constructor(
    database: NexusStateDatabase,
    workspaceId: string,
    options: SqliteChangeSetStoreOptions = {},
  ) {
    if (!workspaceId || workspaceId.includes("\0")) {
      throw new Error(
        "SQLite change-set workspace id must be non-empty and NUL-free",
      )
    }
    this.#database = database
    this.#workspaceId = workspaceId
    this.#maxBlobBytes = positiveSafeInteger(
      "SQLite change-set blob limit",
      options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES,
    )
    this.#maxRecordBytes = positiveSafeInteger(
      "SQLite change-set record limit",
      options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
    )
    this.#listLimit = positiveSafeInteger(
      "SQLite change-set list limit",
      options.listLimit ?? DEFAULT_LIST_LIMIT,
    )
    if (this.#listLimit >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError(
        "SQLite change-set list limit must allow one overflow sentinel row",
      )
    }
    this.#now = options.now ?? Date.now
  }

  async putBlob(hash: string, content: Uint8Array): Promise<void> {
    if (!SHA256_PATTERN.test(hash)) {
      throw new Error("Change-set blob id must be a lowercase SHA-256 hash")
    }
    const bytes = Buffer.from(content)
    if (bytes.byteLength > this.#maxBlobBytes) {
      throw new RangeError(
        `Change-set blob exceeds the ${this.#maxBlobBytes}-byte limit`,
      )
    }
    if (hashFileContent(bytes).hash !== hash) {
      throw new Error("Change-set blob content does not match its hash")
    }
    const createdAt = this.#now()
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
      throw new RangeError(
        "SQLite change-set time must be a non-negative safe integer",
      )
    }
    this.#database.transaction((connection) => {
      connection.run(
        `INSERT OR IGNORE INTO change_blob
           (hash, content, byte_length, created_at)
         VALUES (?, ?, ?, ?)`,
        [hash, bytes, bytes.byteLength, createdAt],
      )
      const stored = connection.get<BlobRow>(
        `SELECT content, byte_length
         FROM change_blob
         WHERE hash = ?`,
        [hash],
      )
      if (
        !stored ||
        stored.byte_length !== bytes.byteLength ||
        !Buffer.from(stored.content).equals(bytes)
      ) {
        throw new Error(
          `Stored change-set blob does not match content hash ${hash}`,
        )
      }
    })
  }

  async getBlob(hash: string): Promise<Buffer> {
    if (!SHA256_PATTERN.test(hash)) {
      throw new Error("Change-set blob id must be a lowercase SHA-256 hash")
    }
    const row = this.#database.read((connection) =>
      connection.get<BlobRow>(
        `SELECT content, byte_length
         FROM change_blob
         WHERE hash = ?`,
        [hash],
      ),
    )
    if (!row) throw new Error(`Unknown change-set blob: ${hash}`)
    const bytes = Buffer.from(row.content)
    if (
      row.byte_length !== bytes.byteLength ||
      bytes.byteLength > this.#maxBlobBytes ||
      hashFileContent(bytes).hash !== hash
    ) {
      throw new Error(`Change-set blob ${hash} failed integrity checks`)
    }
    return bytes
  }

  async insert(record: ChangeSetRecord): Promise<void> {
    validateRecord(record, this.#workspaceId)
    if (record.revision !== 0 || record.state !== "proposed") {
      throw new Error(
        "A new change set must be an initial proposed revision",
      )
    }
    const serialized = serializeRecord(record, this.#maxRecordBytes)
    try {
      this.#database.transaction((connection) => {
        const identityOwner = connection
          .all<ChangeSetRow>(
            `SELECT record_json
             FROM change_set
             WHERE workspace_id = ? AND session_id = ? AND turn_id = ?`,
            [
              this.#workspaceId,
              record.identity.sessionId,
              record.identity.turnId,
            ],
          )
          .map((row) =>
            parseRecord(row.record_json, this.#workspaceId),
          )
          .find((candidate) =>
            sameChangeIdentity(candidate.identity, record.identity),
          )
        if (identityOwner) {
          throw new ChangeSetStoreConflictError(
            `Change identity already belongs to ${identityOwner.id}`,
          )
        }
        connection.run(
          `INSERT INTO change_set (
             id, workspace_id, session_id, turn_id, proposal_hash,
             state, revision, record_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            record.id,
            this.#workspaceId,
            record.identity.sessionId,
            record.identity.turnId,
            record.proposalHash,
            record.state,
            record.revision,
            serialized,
            record.createdAt,
            record.updatedAt,
          ],
        )
      })
    } catch (error) {
      throw new ChangeSetStoreConflictError(
        `Could not insert change set ${record.id}: ` +
        (error instanceof Error ? error.message : String(error)),
      )
    }
  }

  async get(id: string): Promise<ChangeSetRecord | undefined> {
    const row = this.#database.read((connection) =>
      connection.get<ChangeSetRow>(
        `SELECT record_json
         FROM change_set
         WHERE id = ? AND workspace_id = ?`,
        [id, this.#workspaceId],
      ),
    )
    return row
      ? parseRecord(row.record_json, this.#workspaceId)
      : undefined
  }

  async list(
    query: ChangeSetListQuery,
  ): Promise<readonly ChangeSetRecord[]> {
    if (query.workspaceId !== this.#workspaceId) {
      throw new Error(
        `Cannot query workspace ${query.workspaceId} through ${this.#workspaceId}`,
      )
    }
    const where = ["workspace_id = ?"]
    const parameters: StateInputValue[] = [this.#workspaceId]
    if (query.sessionId !== undefined) {
      where.push("session_id = ?")
      parameters.push(query.sessionId)
    }
    if (query.turnId !== undefined) {
      where.push("turn_id = ?")
      parameters.push(query.turnId)
    }
    if (query.states !== undefined) {
      if (query.states.length === 0) return []
      for (const state of query.states) {
        if (!CHANGE_SET_STATES.has(state)) {
          throw new Error(`Unknown change-set state: ${state}`)
        }
      }
      where.push(
        `state IN (${query.states.map(() => "?").join(", ")})`,
      )
      parameters.push(...query.states)
    }
    parameters.push(this.#listLimit + 1)
    const rows = this.#database.read((connection) =>
      connection.all<ChangeSetRow>(
        `SELECT record_json
         FROM change_set
         WHERE ${where.join(" AND ")}
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
        parameters,
      ),
    )
    if (rows.length > this.#listLimit) {
      throw new RangeError(
        `SQLite change-set query exceeded the ${this.#listLimit}-record limit; refusing an incomplete result`,
      )
    }
    return rows.map((row) =>
      parseRecord(row.record_json, this.#workspaceId),
    )
  }

  async replace(
    record: ChangeSetRecord,
    expectedRevision: number,
  ): Promise<void> {
    validateRecord(record, this.#workspaceId)
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      record.revision !== expectedRevision + 1
    ) {
      throw new ChangeSetStoreConflictError(
        `Invalid change-set revision transition for ${record.id}`,
      )
    }
    const serialized = serializeRecord(record, this.#maxRecordBytes)
    this.#database.transaction((connection) => {
      const row = connection.get<ChangeSetRow>(
        `SELECT record_json
         FROM change_set
         WHERE id = ? AND workspace_id = ?`,
        [record.id, this.#workspaceId],
      )
      if (!row) {
        throw new ChangeSetStoreConflictError(
          `Unknown change set: ${record.id}`,
        )
      }
      const current = parseRecord(
        row.record_json,
        this.#workspaceId,
      )
      if (current.revision !== expectedRevision) {
        throw new ChangeSetStoreConflictError(
          `Change set ${record.id} revision conflict: expected ` +
          `${expectedRevision}, found ${current.revision}`,
        )
      }
      if (
        JSON.stringify(immutableProjection(current)) !==
        JSON.stringify(immutableProjection(record))
      ) {
        throw new ChangeSetStoreConflictError(
          `Change set ${record.id} immutable proposal ownership changed`,
        )
      }
      if (record.updatedAt < current.updatedAt) {
        throw new ChangeSetStoreConflictError(
          `Change set ${record.id} updatedAt moved backwards`,
        )
      }
      assertChangeSetTransition(current.state, record.state)
      const result = connection.run(
        `UPDATE change_set
         SET state = ?, revision = ?, record_json = ?, updated_at = ?
         WHERE id = ? AND workspace_id = ? AND revision = ?`,
        [
          record.state,
          record.revision,
          serialized,
          record.updatedAt,
          record.id,
          this.#workspaceId,
          expectedRevision,
        ],
      )
      if (!changedExactlyOnce(result.changes)) {
        throw new ChangeSetStoreConflictError(
          `Change set ${record.id} compare-and-swap failed`,
        )
      }
    })
  }
}
